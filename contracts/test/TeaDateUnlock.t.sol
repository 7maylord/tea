// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TeaDateUnlock} from "../src/TeaDateUnlock.sol";
import {TestToken} from "./TeaStream.t.sol";

contract TeaDateUnlockTest is Test {
    event LockCreated(
        uint256 indexed lockId,
        address indexed sender,
        address indexed recipient,
        address token,
        uint256 amount,
        uint64 unlockAt
    );
    event LockWithdrawn(
        uint256 indexed lockId, address indexed sender, address indexed recipient, address token, uint256 amount
    );
    TestToken token;
    TeaDateUnlock dateUnlock;
    address recipient = address(0xB0B);

    function setUp() public {
        vm.warp(1000);
        token = new TestToken();
        dateUnlock = new TeaDateUnlock(address(this));
        dateUnlock.setTokenSupported(address(token), true);
        token.mint(address(this), 1000);
        token.approve(address(dateUnlock), type(uint256).max);
    }

    function testExactBoundaryAndEventsAndSinglePayout() public {
        vm.expectEmit(true, true, true, true, address(dateUnlock));
        emit LockCreated(1, address(this), recipient, address(token), 101, 1100);
        uint256 id = dateUnlock.create(address(token), recipient, 101, 1100);
        vm.warp(1099);
        assertEq(dateUnlock.withdrawable(id), 0);
        vm.prank(recipient);
        vm.expectRevert(TeaDateUnlock.StillLocked.selector);
        dateUnlock.withdraw(id);
        vm.warp(1100);
        assertEq(dateUnlock.withdrawable(id), 101);
        vm.expectEmit(true, true, true, true, address(dateUnlock));
        emit LockWithdrawn(id, address(this), recipient, address(token), 101);
        vm.prank(recipient);
        assertEq(dateUnlock.withdraw(id), 101);
        assertEq(dateUnlock.withdrawable(id), 0);
        vm.prank(recipient);
        vm.expectRevert(TeaDateUnlock.AlreadyWithdrawn.selector);
        dateUnlock.withdraw(id);
        assertEq(token.balanceOf(recipient), 101);
        assertEq(dateUnlock.totalLiability(address(token)), 0);
    }

    function testRejectsInvalidTermsAndUnknownLocks() public {
        vm.expectRevert();
        new TeaDateUnlock(address(0));
        vm.expectRevert(TeaDateUnlock.InvalidTerms.selector);
        dateUnlock.create(address(token), address(0), 1, 1100);
        vm.expectRevert(TeaDateUnlock.InvalidTerms.selector);
        dateUnlock.create(address(token), address(dateUnlock), 1, 1100);
        vm.expectRevert(TeaDateUnlock.InvalidTerms.selector);
        dateUnlock.create(address(token), recipient, 0, 1100);
        vm.expectRevert(TeaDateUnlock.InvalidTerms.selector);
        dateUnlock.create(address(token), recipient, 1, 1000);
        vm.expectRevert(TeaDateUnlock.InvalidTerms.selector);
        dateUnlock.create(address(token), recipient, 1, 999);
        vm.expectRevert(TeaDateUnlock.InvalidLock.selector);
        dateUnlock.withdraw(0);
        vm.expectRevert(TeaDateUnlock.InvalidLock.selector);
        dateUnlock.withdrawable(1);
    }

    function testSenderCannotRecoverOrRedirectLockedFunds() public {
        uint256 id = dateUnlock.create(address(token), recipient, 100, 1100);
        vm.warp(1100);
        vm.expectRevert(TeaDateUnlock.Unauthorized.selector);
        dateUnlock.withdraw(id);
        (bool canceled,) = address(dateUnlock).call(abi.encodeWithSignature("cancel(uint256)", id));
        assertFalse(canceled);
        assertEq(dateUnlock.totalLiability(address(token)), 100);
    }

    function testRejectsFeeDepositAndRollsBackFailedPayout() public {
        token.setChargeFee(true);
        vm.expectRevert(TeaDateUnlock.UnsupportedToken.selector);
        dateUnlock.create(address(token), recipient, 100, 1100);
        assertEq(dateUnlock.nextLockId(), 1);
        token.setChargeFee(false);
        uint256 id = dateUnlock.create(address(token), recipient, 100, 1100);
        token.setChargeFee(true);
        vm.warp(1100);
        vm.prank(recipient);
        vm.expectRevert(TeaDateUnlock.UnsupportedToken.selector);
        dateUnlock.withdraw(id);
        assertEq(dateUnlock.withdrawable(id), 100);
        assertEq(dateUnlock.totalLiability(address(token)), 100);
        token.setChargeFee(false);
        vm.prank(recipient);
        dateUnlock.withdraw(id);
        assertEq(token.balanceOf(recipient), 100);
    }

    function testFuzzNoEarlyOrPartialRelease(uint96 rawAmount, uint32 delay, uint32 elapsed) public {
        uint256 amount = bound(rawAmount, 1, type(uint96).max);
        uint64 unlockAt = uint64(1000 + bound(delay, 1, 365 days));
        token.mint(address(this), amount);
        uint256 id = dateUnlock.create(address(token), recipient, amount, unlockAt);
        vm.warp(1000 + uint256(elapsed));
        assertEq(dateUnlock.withdrawable(id), block.timestamp < unlockAt ? 0 : amount);
        vm.warp(unlockAt);
        vm.prank(recipient);
        dateUnlock.withdraw(id);
        assertEq(token.balanceOf(recipient), amount);
        assertEq(dateUnlock.totalLiability(address(token)), 0);
    }
}
