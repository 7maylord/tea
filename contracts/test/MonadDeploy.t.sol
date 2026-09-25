// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MonadDeployScript} from "../script/MonadDeploy.s.sol";
import {TeaDateUnlock} from "../src/TeaDateUnlock.sol";
import {TeaStream} from "../src/TeaStream.sol";
import {TeaClaimEscrow} from "../src/TeaClaimEscrow.sol";
import {TestUSD} from "../src/TestUSD.sol";

contract MonadDeployTest is Test {
    function testDeploysTestTokenAndBindsBothContractsToIt() public {
        vm.chainId(10143);
        // Local simulation only: this test key must never be used for a broadcast.
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "11");
        vm.setEnv("SETTLEMENT_TOKEN", vm.toString(address(0)));
        vm.setEnv("CLAIM_IDENTITY_SIGNER", vm.toString(address(0xA11CE)));
        vm.setEnv("CLAIM_ADMIN", vm.toString(address(this)));
        (TeaStream stream, TeaClaimEscrow escrow, TeaDateUnlock dateUnlock) = new MonadDeployScript().run();
        assertEq(address(stream.token()), address(escrow.token()));
        assertEq(address(stream.token()), address(dateUnlock.token()));
        assertEq(TestUSD(address(stream.token())).decimals(), 6);
        assertEq(escrow.identitySigner(), address(0xA11CE));
        assertEq(escrow.owner(), address(this));
    }

    function testRejectsWrongNetworkBeforeReadingSecrets() public {
        vm.chainId(143);
        MonadDeployScript deployment = new MonadDeployScript();
        vm.expectRevert("Monad testnet only");
        deployment.run();
    }
}
