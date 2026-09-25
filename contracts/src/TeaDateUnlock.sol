// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Fully funded, non-cancelable payments released at a Unix UTC timestamp.
contract TeaDateUnlock is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Lock {
        address sender;
        address recipient;
        uint256 amount;
        uint64 unlockAt;
        bool withdrawn;
    }

    IERC20 public immutable token;
    uint256 public nextLockId = 1;
    uint256 public totalLiability;
    mapping(uint256 => Lock) public locks;

    error InvalidTerms();
    error InvalidLock();
    error Unauthorized();
    error StillLocked();
    error AlreadyWithdrawn();
    error UnsupportedToken();

    event LockCreated(
        uint256 indexed lockId, address indexed sender, address indexed recipient, uint256 amount, uint64 unlockAt
    );
    event LockWithdrawn(uint256 indexed lockId, address indexed sender, address indexed recipient, uint256 amount);

    constructor(IERC20 settlementToken) {
        if (address(settlementToken).code.length == 0) revert InvalidTerms();
        token = settlementToken;
    }

    function create(address recipient, uint256 amount, uint64 unlockAt) external nonReentrant returns (uint256 lockId) {
        if (recipient == address(0) || recipient == address(this) || amount == 0 || unlockAt <= block.timestamp) {
            revert InvalidTerms();
        }
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) != beforeBalance + amount) revert UnsupportedToken();
        lockId = nextLockId++;
        locks[lockId] = Lock(msg.sender, recipient, amount, unlockAt, false);
        totalLiability += amount;
        emit LockCreated(lockId, msg.sender, recipient, amount, unlockAt);
    }

    function withdrawable(uint256 lockId) public view returns (uint256) {
        Lock storage funded = locks[lockId];
        if (funded.sender == address(0)) revert InvalidLock();
        return !funded.withdrawn && block.timestamp >= funded.unlockAt ? funded.amount : 0;
    }

    function withdraw(uint256 lockId) external nonReentrant returns (uint256 amount) {
        Lock storage funded = locks[lockId];
        if (funded.sender == address(0)) revert InvalidLock();
        if (msg.sender != funded.recipient) revert Unauthorized();
        if (funded.withdrawn) revert AlreadyWithdrawn();
        if (block.timestamp < funded.unlockAt) revert StillLocked();
        amount = funded.amount;
        funded.withdrawn = true;
        totalLiability -= amount;
        uint256 beforeBalance = token.balanceOf(address(this));
        uint256 beforeRecipient = token.balanceOf(funded.recipient);
        token.safeTransfer(funded.recipient, amount);
        if (
            token.balanceOf(address(this)) != beforeBalance - amount
                || token.balanceOf(funded.recipient) != beforeRecipient + amount
        ) {
            revert UnsupportedToken();
        }
        emit LockWithdrawn(lockId, funded.sender, funded.recipient, amount);
    }
}
