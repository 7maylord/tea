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
    address private constant MONAD_TESTNET_AUSD = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;

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
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        require(vm.addr(deployerKey) == admin, "Admin must be deployer");
        vm.startBroadcast(deployerKey);
        if (address(token) == address(0)) token = new TestUSD();
        stream = new TeaStream(admin);
        escrow = new TeaClaimEscrow(signer, admin);
        dateUnlock = new TeaDateUnlock(admin);
        stream.setTokenSupported(address(token), true);
        escrow.setTokenSupported(address(token), true);
        dateUnlock.setTokenSupported(address(token), true);
        address ausd = vm.envOr("AUSD_TOKEN", MONAD_TESTNET_AUSD);
        if (ausd != address(0) && ausd != address(token)) {
            require(ausd.code.length > 0, "AUSD has no code");
            require(IERC20Metadata(ausd).decimals() == 6, "AUSD requires 6 decimals");
            stream.setTokenSupported(ausd, true);
            escrow.setTokenSupported(ausd, true);
            dateUnlock.setTokenSupported(ausd, true);
        }
        vm.stopBroadcast();
        console2.log("SettlementToken", address(token));
        console2.log("TeaDateUnlock", address(dateUnlock));
        console2.log("TeaStream", address(stream));
        console2.log("TeaClaimEscrow", address(escrow));
    }
}
