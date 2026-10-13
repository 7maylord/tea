// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TeaStream} from "../src/TeaStream.sol";

contract TeaStreamScript is Script {
    function run() external returns (TeaStream deployed) {
        address settlementToken = vm.envAddress("SETTLEMENT_TOKEN");
        vm.startBroadcast();
        address admin = vm.addr(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        deployed = new TeaStream(admin);
        deployed.setTokenSupported(settlementToken, true);
        vm.stopBroadcast();
    }
}
