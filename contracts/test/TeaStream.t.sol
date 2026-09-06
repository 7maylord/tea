// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TeaStream} from "../src/TeaStream.sol";

contract TestToken is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    bool public chargeFee;

    function setChargeFee(bool enabled) external {
        chargeFee = enabled;
    }

    function name() external pure returns (string memory) {
        return "Test USD";
    }

    function symbol() external pure returns (string memory) {
        return "TUSD";
    }

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        uint256 received = chargeFee ? amount - 1 : amount;
        balanceOf[to] += received;
        totalSupply -= amount - received;
        emit Transfer(from, to, received);
    }
}

contract TeaStreamTest is Test {
    TestToken token;
    TeaStream stream;
    address sender = address(0xA11CE);
    address recipient = address(0xB0B);

    function setUp() public {
        token = new TestToken();
        stream = new TeaStream(token);
        token.mint(sender, 1_000_000);
        vm.prank(sender);
        token.approve(address(stream), type(uint256).max);
        vm.warp(1_000);
    }

    function _create(uint256 amount, uint64 duration) private returns (uint256 id) {
        vm.prank(sender);
        id = stream.create(recipient, amount, duration);
    }

    function testPartialWithdrawCancelAndFinalDust() public {
        uint256 id = _create(101, 10);
        assertEq(stream.withdrawable(id), 0);
        vm.prank(recipient);
        vm.expectRevert(TeaStream.NothingToWithdraw.selector);
        stream.withdraw(id);

        vm.warp(1_003);
        vm.prank(recipient);
        assertEq(stream.withdraw(id), 30);
        vm.warp(1_007);
        vm.prank(sender);
        assertEq(stream.cancel(id), 31);
        assertEq(stream.totalLiability(), 40);
        vm.warp(2_000);
        assertEq(stream.withdrawable(id), 40);
        vm.prank(recipient);
        assertEq(stream.withdraw(id), 40);
        assertEq(token.balanceOf(recipient), 70);
        assertEq(token.balanceOf(sender), 1_000_000 - 70);
        assertEq(stream.totalLiability(), 0);
        assertEq(token.balanceOf(address(stream)), 0);
    }

    function testEndPaysWholeDepositIncludingDust() public {
        uint256 id = _create(101, 10);
        vm.warp(1_010);
        vm.prank(recipient);
        assertEq(stream.withdraw(id), 101);
        vm.prank(sender);
        vm.expectRevert(TeaStream.StreamEnded.selector);
        stream.cancel(id);
    }

    function testRightsAndDoubleActions() public {
        uint256 id = _create(100, 10);
        vm.prank(sender);
        vm.expectRevert(TeaStream.Unauthorized.selector);
        stream.withdraw(id);
        vm.prank(recipient);
        vm.expectRevert(TeaStream.Unauthorized.selector);
        stream.cancel(id);
        vm.prank(sender);
        stream.cancel(id);
        vm.prank(sender);
        vm.expectRevert(TeaStream.AlreadyCanceled.selector);
        stream.cancel(id);
    }

    function testRejectsFeeOnTransfer() public {
        token.setChargeFee(true);
        vm.prank(sender);
        vm.expectRevert(TeaStream.UnsupportedToken.selector);
        stream.create(recipient, 100, 10);
        assertEq(token.balanceOf(address(stream)), 0);
    }

    function testRejectedPayoutKeepsEntitlement() public {
        uint256 id = _create(100, 10);
        vm.warp(1_010);
        token.setChargeFee(true);
        vm.prank(recipient);
        vm.expectRevert(TeaStream.UnsupportedToken.selector);
        stream.withdraw(id);
        assertEq(stream.withdrawable(id), 100);
        assertEq(stream.totalLiability(), 100);
        assertEq(token.balanceOf(address(stream)), 100);
    }

    function testLargeDepositAccrualDoesNotOverflow() public {
        uint256 amount = uint256(1) << 255;
        token.mint(sender, amount);
        uint256 id = _create(amount, 1_000);
        vm.warp(1_500);
        assertEq(stream.vested(id), amount / 2);
    }

    function testConcurrentStreamsRemainFullyBacked() public {
        uint256 first = _create(101, 10);
        uint256 second = _create(99, 20);
        assertEq(stream.totalLiability(), 200);
        assertEq(token.balanceOf(address(stream)), 200);

        vm.warp(1_005);
        vm.prank(sender);
        assertEq(stream.cancel(first), 51);
        vm.prank(recipient);
        assertEq(stream.withdraw(first), 50);
        assertEq(stream.totalLiability(), 99);
        assertEq(token.balanceOf(address(stream)), 99);

        vm.warp(1_020);
        vm.prank(recipient);
        assertEq(stream.withdraw(second), 99);
        assertEq(stream.totalLiability(), 0);
        assertEq(token.balanceOf(address(stream)), 0);
    }

    function testFuzzConservesFunds(uint96 amount, uint32 duration, uint32 elapsed) public {
        vm.assume(amount > 0 && amount <= 1_000_000 && duration > 0);
        uint256 id = _create(amount, duration);
        vm.warp(1_000 + uint256(elapsed % duration));
        vm.prank(sender);
        uint256 refund = stream.cancel(id);
        uint256 collected;
        if (stream.withdrawable(id) > 0) {
            vm.prank(recipient);
            collected = stream.withdraw(id);
        }
        assertEq(refund + collected, amount);
        assertEq(stream.totalLiability(), 0);
        assertEq(token.balanceOf(address(stream)), 0);
    }
}
