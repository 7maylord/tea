// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Fully funded, non-transferable, linear streams of one ERC-20 token.
contract TeaStream is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Stream {
        address sender;
        address recipient;
        uint256 deposit;
        uint256 withdrawn;
        uint256 entitlement; // Set only on cancellation.
        uint64 start;
        uint64 end;
        bool canceled;
    }

    IERC20 public immutable token;
    uint256 public nextStreamId = 1;
    uint256 public totalLiability;
    mapping(uint256 => Stream) public streams;

    error InvalidStream();
    error Unauthorized();
    error InvalidTerms();
    error NothingToWithdraw();
    error AlreadyCanceled();
    error StreamEnded();
    error UnsupportedToken();

    event StreamCreated(
        uint256 indexed streamId,
        address indexed sender,
        address indexed recipient,
        uint256 deposit,
        uint64 start,
        uint64 end
    );
    event StreamWithdrawn(uint256 indexed streamId, address indexed sender, address indexed recipient, uint256 amount);
    event StreamCanceled(
        uint256 indexed streamId,
        address indexed sender,
        address indexed recipient,
        uint256 recipientEntitlement,
        uint256 senderRefund
    );

    constructor(IERC20 settlementToken) {
        if (address(settlementToken).code.length == 0) revert InvalidTerms();
        token = settlementToken;
    }

    function create(address recipient, uint256 amount, uint64 duration)
        external
        nonReentrant
        returns (uint256 streamId)
    {
        if (recipient == address(0) || recipient == address(this) || amount == 0 || duration == 0) revert InvalidTerms();
        if (block.timestamp > type(uint64).max - duration) revert InvalidTerms();

        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) != beforeBalance + amount) revert UnsupportedToken();

        streamId = nextStreamId++;
        uint64 start = uint64(block.timestamp);
        uint64 end = start + duration;
        streams[streamId] = Stream(msg.sender, recipient, amount, 0, 0, start, end, false);
        totalLiability += amount;
        emit StreamCreated(streamId, msg.sender, recipient, amount, start, end);
    }

    function vested(uint256 streamId) public view returns (uint256) {
        Stream storage stream = streams[streamId];
        if (stream.sender == address(0)) revert InvalidStream();
        if (stream.canceled) return stream.entitlement;
        if (block.timestamp <= stream.start) return 0;
        if (block.timestamp >= stream.end) return stream.deposit;

        uint256 duration = stream.end - stream.start;
        uint256 elapsed = block.timestamp - stream.start;
        return Math.mulDiv(stream.deposit, elapsed, duration);
    }

    function withdrawable(uint256 streamId) public view returns (uint256) {
        return vested(streamId) - streams[streamId].withdrawn;
    }

    function withdraw(uint256 streamId) external nonReentrant returns (uint256 amount) {
        Stream storage stream = streams[streamId];
        if (stream.sender == address(0)) revert InvalidStream();
        if (msg.sender != stream.recipient) revert Unauthorized();
        amount = withdrawable(streamId);
        if (amount == 0) revert NothingToWithdraw();

        stream.withdrawn += amount;
        totalLiability -= amount;
        _send(stream.recipient, amount);
        emit StreamWithdrawn(streamId, stream.sender, stream.recipient, amount);
    }

    function cancel(uint256 streamId) external nonReentrant returns (uint256 refund) {
        Stream storage stream = streams[streamId];
        if (stream.sender == address(0)) revert InvalidStream();
        if (msg.sender != stream.sender) revert Unauthorized();
        if (stream.canceled) revert AlreadyCanceled();
        if (block.timestamp >= stream.end) revert StreamEnded();

        uint256 entitlement = vested(streamId);
        refund = stream.deposit - entitlement;
        stream.entitlement = entitlement;
        stream.canceled = true;
        totalLiability -= refund;
        if (refund != 0) _send(stream.sender, refund);
        emit StreamCanceled(streamId, stream.sender, stream.recipient, entitlement, refund);
    }

    function _send(address recipient, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        uint256 beforeRecipient = token.balanceOf(recipient);
        token.safeTransfer(recipient, amount);
        if (
            token.balanceOf(address(this)) != beforeBalance - amount
                || token.balanceOf(recipient) != beforeRecipient + amount
        ) {
            revert UnsupportedToken();
        }
    }
}
