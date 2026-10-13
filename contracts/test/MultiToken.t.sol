// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TeaClaimEscrow} from "../src/TeaClaimEscrow.sol";
import {TeaDateUnlock} from "../src/TeaDateUnlock.sol";
import {TeaStream} from "../src/TeaStream.sol";
import {TestToken} from "./TeaStream.t.sol";

contract MultiTokenTest is Test {
    TestToken private tokenA;
    TestToken private tokenB;
    TestToken private unsupported;
    TeaClaimEscrow private escrow;
    TeaStream private stream;
    TeaDateUnlock private dateUnlock;

    function setUp() public {
        tokenA = new TestToken();
        tokenB = new TestToken();
        unsupported = new TestToken();
        escrow = new TeaClaimEscrow(address(0xA11CE), address(this));
        stream = new TeaStream(address(this));
        dateUnlock = new TeaDateUnlock(address(this));
        escrow.setTokenSupported(address(tokenA), true);
        escrow.setTokenSupported(address(tokenB), true);
        stream.setTokenSupported(address(tokenA), true);
        stream.setTokenSupported(address(tokenB), true);
        dateUnlock.setTokenSupported(address(tokenA), true);
        dateUnlock.setTokenSupported(address(tokenB), true);
        tokenA.mint(address(this), 1_000);
        tokenB.mint(address(this), 1_000);
        tokenA.approve(address(escrow), type(uint256).max);
        tokenB.approve(address(escrow), type(uint256).max);
        tokenA.approve(address(stream), type(uint256).max);
        tokenB.approve(address(stream), type(uint256).max);
        tokenA.approve(address(dateUnlock), type(uint256).max);
        tokenB.approve(address(dateUnlock), type(uint256).max);
        vm.warp(1_000);
    }

    function testLiabilitiesStaySeparatedByToken() public {
        escrow.deposit(bytes32(uint256(1)), bytes32(uint256(11)), address(tokenA), 10);
        escrow.deposit(bytes32(uint256(2)), bytes32(uint256(22)), address(tokenB), 20);
        stream.create(address(tokenA), address(1), 30, 100);
        stream.create(address(tokenB), address(2), 40, 100);
        dateUnlock.create(address(tokenA), address(1), 50, 1_100);
        dateUnlock.create(address(tokenB), address(2), 60, 1_100);

        assertEq(escrow.totalLiability(address(tokenA)), 10);
        assertEq(escrow.totalLiability(address(tokenB)), 20);
        assertEq(stream.totalLiability(address(tokenA)), 30);
        assertEq(stream.totalLiability(address(tokenB)), 40);
        assertEq(dateUnlock.totalLiability(address(tokenA)), 50);
        assertEq(dateUnlock.totalLiability(address(tokenB)), 60);
    }

    function testEveryEntryPointRejectsUnsupportedTokens() public {
        vm.expectRevert(TeaClaimEscrow.InvalidTerms.selector);
        escrow.deposit(bytes32(uint256(1)), bytes32(uint256(11)), address(unsupported), 1);
        vm.expectRevert(TeaStream.InvalidTerms.selector);
        stream.create(address(unsupported), address(1), 1, 1);
        vm.expectRevert(TeaDateUnlock.InvalidTerms.selector);
        dateUnlock.create(address(unsupported), address(1), 1, 1_001);
    }
}
