// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TeaDateUnlock} from "../src/TeaDateUnlock.sol";
import {TeaStream} from "../src/TeaStream.sol";
import {TeaClaimEscrow} from "../src/TeaClaimEscrow.sol";
import {TestUSD} from "../src/TestUSD.sol";

contract MonadDeployScript is Script {
    function run() external returns (TeaStream stream, TeaClaimEscrow escrow, TeaDateUnlock dateUnlock) {
        require(block.chainid == 10143, "Monad testnet only");
        IERC20Metadata token = IERC20Metadata(vm.envOr("SETTLEMENT_TOKEN", address(0)));
        if (address(token) != address(0)) {
            require(address(token).code.length > 0, "Token has no code");
            require(token.decimals() == 6, "TEA currently requires 6 decimals");
        }
        address signer = vm.envAddress("CLAIM_IDENTITY_SIGNER");
        address admin = vm.envAddress("CLAIM_ADMIN");
        require(signer != address(0) && admin != address(0), "Missing signer or admin");
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        if (address(token) == address(0)) token = new TestUSD();
        stream = new TeaStream(token);
        escrow = new TeaClaimEscrow(token, signer, admin);
        dateUnlock = new TeaDateUnlock(token);
        vm.stopBroadcast();
        console2.log("SettlementToken", address(token));
        console2.log("TeaDateUnlock", address(dateUnlock));
        console2.log("TeaStream", address(stream));
        console2.log("TeaClaimEscrow", address(escrow));
    }
}
