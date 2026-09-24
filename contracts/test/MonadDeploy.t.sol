// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MonadDeployScript} from "../script/MonadDeploy.s.sol";

contract MonadDeployTest is Test {
    function testRejectsWrongNetworkBeforeReadingSecrets() public {
        vm.chainId(143);
        MonadDeployScript deployment = new MonadDeployScript();
        vm.expectRevert("Monad testnet only");
        deployment.run();
    }
}
