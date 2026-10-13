// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {TeaStream} from "../src/TeaStream.sol";
import {TeaClaimEscrow} from "../src/TeaClaimEscrow.sol";

contract TestUSDTest is Test {
    event Transfer(address indexed from, address indexed to, uint256 value);

    function testRejectsMainnetDeployment() public {
        vm.chainId(143);
        vm.expectRevert("Monad testnet only");
        new TestUSD();
    }

    function testPublicMintAndSendEmitStandardIndexerEvents() public {
        vm.chainId(10143);
        TestUSD token = new TestUSD();
        assertEq(token.decimals(), 6);
        assertEq(token.name(), "TEA Test USD (no cash value)");
        assertEq(token.symbol(), "TUSD");
        vm.expectEmit(true, true, false, true, address(token));
        emit Transfer(address(0), address(this), 20e6);
        vm.prank(address(0xB0B));
        token.mint(address(this), 20e6);
        vm.expectEmit(true, true, false, true, address(token));
        emit Transfer(address(this), address(0xB0B), 5e6);
        token.transfer(address(0xB0B), 5e6);
        assertEq(token.balanceOf(address(this)), 15e6);
        assertEq(token.balanceOf(address(0xB0B)), 5e6);
        assertEq(token.totalSupply(), 20e6);
    }

    function testFundsStreamsAndExpiredClaimsWithoutFees() public {
        vm.chainId(10143);
        TestUSD token = new TestUSD();
        TeaStream stream = new TeaStream(address(this));
        TeaClaimEscrow escrow = new TeaClaimEscrow(address(0xA11CE), address(this));
        stream.setTokenSupported(address(token), true);
        escrow.setTokenSupported(address(token), true);
        token.mint(address(this), 20e6);
        token.approve(address(stream), 10e6);
        token.approve(address(escrow), 10e6);
        uint256 id = stream.create(address(token), address(0xB0B), 10e6, 1 days);
        escrow.deposit(bytes32(uint256(1)), bytes32(uint256(2)), address(token), 10e6);
        vm.warp(block.timestamp + 14 days);
        vm.prank(address(0xB0B));
        assertEq(stream.withdraw(id), 10e6);
        escrow.refund(bytes32(uint256(1)));
        assertEq(token.balanceOf(address(this)), 10e6);
        assertEq(token.balanceOf(address(0xB0B)), 10e6);
        assertEq(stream.totalLiability(address(token)) + escrow.totalLiability(address(token)), 0);
    }
}
