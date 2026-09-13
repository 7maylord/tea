// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice Holds one supported ERC-20 until the verified recipient accepts or the payer is refunded.
contract TeaClaimEscrow is Ownable, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    enum ClaimStatus {
        None,
        Open,
        Claimed,
        Refunded
    }

    struct Claim {
        address payer;
        uint256 amount;
        uint64 expiry;
        bytes32 identityCommitment;
        ClaimStatus status;
    }

    struct ClaimAuthorization {
        bytes32 claimId;
        bytes32 identityCommitment;
        address token;
        uint256 amount;
        address recipient;
        uint256 nonce;
        uint64 deadline;
        uint64 signerEpoch;
    }

    bytes32 private constant AUTHORIZATION_TYPEHASH = keccak256(
        "ClaimAuthorization(bytes32 claimId,bytes32 identityCommitment,address token,uint256 amount,address recipient,uint256 nonce,uint64 deadline,uint64 signerEpoch)"
    );
    bytes32 private constant ACCEPTANCE_TYPEHASH = keccak256("ClaimAcceptance(bytes32 authorizationDigest)");
    uint64 public constant CLAIM_DURATION = 14 days;

    IERC20 public immutable token;
    address public identitySigner;
    uint64 public signerEpoch = 1;
    uint256 public totalLiability;
    mapping(bytes32 => Claim) public claims;
    mapping(bytes32 => uint256) public nonces;

    error InvalidTerms();
    error InvalidClaim();
    error ClaimExpired();
    error ClaimNotExpired();
    error InvalidAuthorization();
    error InvalidSignature();
    error UnsupportedToken();

    event ClaimDeposited(
        bytes32 indexed claimId,
        address indexed payer,
        bytes32 indexed identityCommitment,
        uint256 amount,
        uint64 expiry
    );
    event ClaimPaid(bytes32 indexed claimId, address indexed payer, address indexed recipient, uint256 amount);
    event ClaimRefunded(bytes32 indexed claimId, address indexed payer, uint256 amount);
    event IdentitySignerRotated(address indexed previousSigner, address indexed newSigner, uint64 signerEpoch);

    constructor(IERC20 settlementToken, address initialIdentitySigner, address initialOwner)
        Ownable(initialOwner)
        EIP712("TeaClaimEscrow", "1")
    {
        if (address(settlementToken).code.length == 0 || initialIdentitySigner == address(0)) {
            revert InvalidTerms();
        }
        token = settlementToken;
        identitySigner = initialIdentitySigner;
    }

    function deposit(bytes32 claimId, bytes32 commitment, uint256 amount) external whenNotPaused nonReentrant {
        if (
            claimId == bytes32(0) || commitment == bytes32(0) || amount == 0
                || claims[claimId].status != ClaimStatus.None
        ) {
            revert InvalidTerms();
        }
        if (block.timestamp > type(uint64).max - CLAIM_DURATION) revert InvalidTerms();

        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) != beforeBalance + amount) revert UnsupportedToken();

        uint64 expiry = uint64(block.timestamp + CLAIM_DURATION);
        claims[claimId] = Claim(msg.sender, amount, expiry, commitment, ClaimStatus.Open);
        totalLiability += amount;
        emit ClaimDeposited(claimId, msg.sender, commitment, amount, expiry);
    }

    function authorizationDigest(ClaimAuthorization calldata authorization) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    AUTHORIZATION_TYPEHASH,
                    authorization.claimId,
                    authorization.identityCommitment,
                    authorization.token,
                    authorization.amount,
                    authorization.recipient,
                    authorization.nonce,
                    authorization.deadline,
                    authorization.signerEpoch
                )
            )
        );
    }

    function acceptanceDigest(bytes32 signedAuthorizationDigest) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ACCEPTANCE_TYPEHASH, signedAuthorizationDigest)));
    }

    function claim(
        ClaimAuthorization calldata authorization,
        bytes calldata identitySignature,
        bytes calldata recipientSignature
    ) external whenNotPaused nonReentrant {
        Claim storage funded = claims[authorization.claimId];
        if (funded.status != ClaimStatus.Open) revert InvalidClaim();
        if (block.timestamp >= funded.expiry) revert ClaimExpired();
        if (
            authorization.identityCommitment != funded.identityCommitment || authorization.token != address(token)
                || authorization.amount != funded.amount || authorization.recipient == address(0)
                || authorization.recipient == address(this) || authorization.nonce != nonces[authorization.claimId]
                || authorization.signerEpoch != signerEpoch || authorization.deadline < block.timestamp
                || authorization.deadline > funded.expiry
        ) revert InvalidAuthorization();

        bytes32 digest = authorizationDigest(authorization);
        if (!SignatureChecker.isValidSignatureNowCalldata(identitySigner, digest, identitySignature)) {
            revert InvalidSignature();
        }
        if (!SignatureChecker.isValidSignatureNowCalldata(
                authorization.recipient, acceptanceDigest(digest), recipientSignature
            )) revert InvalidSignature();

        nonces[authorization.claimId]++;
        funded.status = ClaimStatus.Claimed;
        totalLiability -= funded.amount;
        _send(authorization.recipient, funded.amount);
        emit ClaimPaid(authorization.claimId, funded.payer, authorization.recipient, funded.amount);
    }

    function refund(bytes32 claimId) external nonReentrant {
        Claim storage funded = claims[claimId];
        if (funded.status != ClaimStatus.Open) revert InvalidClaim();
        if (block.timestamp < funded.expiry) revert ClaimNotExpired();

        funded.status = ClaimStatus.Refunded;
        totalLiability -= funded.amount;
        _send(funded.payer, funded.amount);
        emit ClaimRefunded(claimId, funded.payer, funded.amount);
    }

    function setPaused(bool shouldPause) external onlyOwner {
        if (shouldPause) _pause();
        else _unpause();
    }

    function rotateIdentitySigner(address newSigner) external onlyOwner {
        if (newSigner == address(0) || newSigner == identitySigner) revert InvalidTerms();
        address previousSigner = identitySigner;
        identitySigner = newSigner;
        signerEpoch++;
        emit IdentitySignerRotated(previousSigner, newSigner, signerEpoch);
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
