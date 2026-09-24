// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TeaStream} from "../src/TeaStream.sol";
import {TeaClaimEscrow} from "../src/TeaClaimEscrow.sol";
import {TestToken} from "./TeaStream.t.sol";

contract AccountingHandler is Test {
    TestToken public token;
    TeaStream public stream;
    TeaClaimEscrow public escrow;
    uint256 public deposited;
    uint256 public paid;
    uint256 public claimCount;
    address public recipient;

    constructor() {
        token = new TestToken();
        stream = new TeaStream(token);
        escrow = new TeaClaimEscrow(token, vm.addr(11), address(this));
        recipient = vm.addr(12);
        token.approve(address(stream), type(uint256).max);
        token.approve(address(escrow), type(uint256).max);
    }

    function fund(uint96 rawAmount, uint32 rawDuration, bool email) external {
        uint256 amount = bound(rawAmount, 1, 1e18);
        token.mint(address(this), amount);
        if (email) escrow.deposit(bytes32(++claimCount), bytes32(uint256(1)), amount);
        else stream.create(recipient, amount, uint64(bound(rawDuration, 1, 30 days)));
        deposited += amount;
    }

    function advance(uint32 elapsed) external {
        vm.warp(block.timestamp + bound(elapsed, 1, 2 days));
    }

    function collect(uint256 seed, bool cancel) external {
        uint256 count = stream.nextStreamId() - 1;
        if (count == 0) return;
        uint256 id = seed % count + 1;
        (,,,,,, uint64 end, bool canceled) = stream.streams(id);
        if (cancel) {
            if (canceled || block.timestamp >= end) return;
            paid += stream.cancel(id);
        } else {
            if (stream.withdrawable(id) == 0) return;
            vm.prank(recipient);
            paid += stream.withdraw(id);
        }
    }

    function settleClaim(uint256 seed) external {
        if (claimCount == 0) return;
        bytes32 id = bytes32(seed % claimCount + 1);
        (, uint256 amount, uint64 expiry, bytes32 commitment, TeaClaimEscrow.ClaimStatus status) = escrow.claims(id);
        if (status != TeaClaimEscrow.ClaimStatus.Open) return;
        if (block.timestamp >= expiry) {
            escrow.refund(id);
        } else {
            TeaClaimEscrow.ClaimAuthorization memory auth =
                TeaClaimEscrow.ClaimAuthorization(id, commitment, address(token), amount, recipient, 0, expiry, 1);
            bytes32 digest = escrow.authorizationDigest(auth);
            escrow.claim(auth, sign(11, digest), sign(12, escrow.acceptanceDigest(digest)));
        }
        paid += amount;
    }

    function sign(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}

contract AccountingInvariantTest is Test {
    AccountingHandler handler;

    function setUp() public {
        handler = new AccountingHandler();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = AccountingHandler.fund.selector;
        selectors[1] = AccountingHandler.advance.selector;
        selectors[2] = AccountingHandler.collect.selector;
        selectors[3] = AccountingHandler.settleClaim.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }

    function invariantEveryDepositedUnitIsPaidOrBacked() public view {
        TeaStream stream = handler.stream();
        TeaClaimEscrow escrow = handler.escrow();
        TestToken token = handler.token();
        assertEq(handler.deposited(), handler.paid() + stream.totalLiability() + escrow.totalLiability());
        assertEq(token.balanceOf(address(stream)), stream.totalLiability());
        assertEq(token.balanceOf(address(escrow)), escrow.totalLiability());
        assertEq(token.balanceOf(address(handler)) + token.balanceOf(handler.recipient()), handler.paid());
    }
}
