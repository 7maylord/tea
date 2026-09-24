// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Valueless Monad testnet funds. Anyone may mint; never treat these as real USD.
contract TestUSD is ERC20 {
    constructor() ERC20("TEA Test USD (no cash value)", "TUSD") {
        require(block.chainid == 10143, "Monad testnet only");
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}
