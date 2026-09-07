// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TeaStream} from "../src/TeaStream.sol";

/// @notice Faucet token for Anvil only. Anyone may mint valueless test funds.
contract MockTestUSD is ERC20 {
    constructor() ERC20("Test USD (no cash value)", "TUSD") {
        require(block.chainid == 31337, "Anvil only");
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract LocalDeployScript is Script {
    function run() external {
        require(block.chainid == 31337, "Anvil only");
        vm.startBroadcast();
        MockTestUSD token = new MockTestUSD();
        TeaStream stream = new TeaStream(token);
        vm.stopBroadcast();
        console2.log("MockTestUSD:", address(token));
        console2.log("TeaStream:", address(stream));
    }
}
