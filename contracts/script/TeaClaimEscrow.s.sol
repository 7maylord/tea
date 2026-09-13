// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TeaClaimEscrow} from "../src/TeaClaimEscrow.sol";

contract TeaClaimEscrowScript is Script {
    function run() external returns (TeaClaimEscrow deployed) {
        address settlementToken = vm.envAddress("SETTLEMENT_TOKEN");
        address identitySigner = vm.envAddress("CLAIM_IDENTITY_SIGNER");
        address admin = vm.envAddress("CLAIM_ADMIN");
        vm.startBroadcast();
        deployed = new TeaClaimEscrow(IERC20(settlementToken), identitySigner, admin);
        vm.stopBroadcast();
    }
}
