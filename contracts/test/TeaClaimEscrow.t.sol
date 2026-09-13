// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20Mock} from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import {ERC1271WalletMock} from "@openzeppelin/contracts/mocks/ERC1271WalletMock.sol";
import {TeaClaimEscrow} from "../src/TeaClaimEscrow.sol";

contract EscrowTestToken is ERC20Mock {
    bool public chargeFee;
    bool public reenter;
    bool public reentryBlocked;
    TeaClaimEscrow public escrow;
    bytes32 public reentryClaimId;

    function configureReentry(TeaClaimEscrow target, bytes32 claimId) external {
        escrow = target;
        reentryClaimId = claimId;
        reenter = true;
    }

    function setChargeFee(bool enabled) external {
        chargeFee = enabled;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (reenter) {
            reenter = false;
            (bool succeeded,) = address(escrow).call(abi.encodeCall(TeaClaimEscrow.refund, (reentryClaimId)));
            reentryBlocked = !succeeded;
        }
        return super.transfer(to, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (chargeFee && from != address(0) && to != address(0)) {
            super._update(from, to, amount - 1);
            super._update(from, address(0), 1);
        } else {
            super._update(from, to, amount);
        }
    }
}

contract TeaClaimEscrowTest is Test {
    uint256 private constant SIGNER_KEY = 11;
    uint256 private constant RECIPIENT_KEY = 12;
    uint256 private constant OTHER_KEY = 13;
    bytes32 private constant CLAIM_ID = keccak256("claim 1");
    bytes32 private constant COMMITMENT = keccak256("secret identity commitment");

    EscrowTestToken token;
    TeaClaimEscrow escrow;
    address payer = address(0xA11CE);
    address recipient;
    address signer;

    function setUp() public {
        vm.warp(1_000);
        signer = vm.addr(SIGNER_KEY);
        recipient = vm.addr(RECIPIENT_KEY);
        token = new EscrowTestToken();
        escrow = new TeaClaimEscrow(token, signer, address(this));
        token.mint(payer, 1_000_000);
        vm.prank(payer);
        token.approve(address(escrow), type(uint256).max);
    }

    function _deposit(uint256 amount) private {
        vm.prank(payer);
        escrow.deposit(CLAIM_ID, COMMITMENT, amount);
    }

    function _authorization(address destination) private view returns (TeaClaimEscrow.ClaimAuthorization memory auth) {
        (, uint256 amount, uint64 expiry, bytes32 commitment,) = escrow.claims(CLAIM_ID);
        auth = TeaClaimEscrow.ClaimAuthorization({
            claimId: CLAIM_ID,
            identityCommitment: commitment,
            token: address(token),
            amount: amount,
            recipient: destination,
            nonce: escrow.nonces(CLAIM_ID),
            deadline: expiry,
            signerEpoch: escrow.signerEpoch()
        });
    }

    function _sign(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _claim(TeaClaimEscrow.ClaimAuthorization memory auth, uint256 recipientKey) private {
        bytes32 digest = escrow.authorizationDigest(auth);
        escrow.claim(auth, _sign(SIGNER_KEY, digest), _sign(recipientKey, escrow.acceptanceDigest(digest)));
    }

    function _expectClaimRevert(TeaClaimEscrow.ClaimAuthorization memory auth, bytes4 reason) private {
        bytes32 digest = escrow.authorizationDigest(auth);
        bytes memory identitySignature = _sign(SIGNER_KEY, digest);
        bytes memory recipientSignature = _sign(RECIPIENT_KEY, escrow.acceptanceDigest(digest));
        vm.expectRevert(reason);
        escrow.claim(auth, identitySignature, recipientSignature);
    }

    function testEOAClaimPaysOnceAndEmitsIndexableFields() public {
        _deposit(100);
        TeaClaimEscrow.ClaimAuthorization memory auth = _authorization(recipient);
        bytes32 digest = escrow.authorizationDigest(auth);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit TeaClaimEscrow.ClaimPaid(CLAIM_ID, payer, recipient, 100);
        vm.prank(address(0xBEEF));
        escrow.claim(auth, _sign(SIGNER_KEY, digest), _sign(RECIPIENT_KEY, escrow.acceptanceDigest(digest)));
        assertEq(token.balanceOf(recipient), 100);
        assertEq(escrow.totalLiability(), 0);
        assertEq(escrow.nonces(CLAIM_ID), 1);
        _expectClaimRevert(auth, TeaClaimEscrow.InvalidClaim.selector);
        vm.warp(1_000 + 14 days);
        vm.expectRevert(TeaClaimEscrow.InvalidClaim.selector);
        escrow.refund(CLAIM_ID);
    }

    function testDeployedERC1271RecipientAccepts() public {
        _deposit(50);
        ERC1271WalletMock wallet = new ERC1271WalletMock(recipient);
        _claim(_authorization(address(wallet)), RECIPIENT_KEY);
        assertEq(token.balanceOf(address(wallet)), 50);
    }

    function testRotatedSignerCanAuthorizeExistingClaim() public {
        _deposit(50);
        escrow.rotateIdentitySigner(vm.addr(OTHER_KEY));
        TeaClaimEscrow.ClaimAuthorization memory auth = _authorization(recipient);
        bytes32 digest = escrow.authorizationDigest(auth);
        escrow.claim(auth, _sign(OTHER_KEY, digest), _sign(RECIPIENT_KEY, escrow.acceptanceDigest(digest)));
        assertEq(token.balanceOf(recipient), 50);
    }

    function testWrongSignaturesAndSignedFieldsFail() public {
        _deposit(100);
        TeaClaimEscrow.ClaimAuthorization memory auth = _authorization(recipient);
        bytes32 digest = escrow.authorizationDigest(auth);
        bytes memory validIdentitySignature = _sign(SIGNER_KEY, digest);
        bytes memory validRecipientSignature = _sign(RECIPIENT_KEY, escrow.acceptanceDigest(digest));
        bytes memory wrongIdentitySignature = _sign(OTHER_KEY, digest);
        bytes memory wrongRecipientSignature = _sign(OTHER_KEY, escrow.acceptanceDigest(digest));
        vm.expectRevert(TeaClaimEscrow.InvalidSignature.selector);
        escrow.claim(auth, wrongIdentitySignature, validRecipientSignature);
        vm.expectRevert(TeaClaimEscrow.InvalidSignature.selector);
        escrow.claim(auth, validIdentitySignature, wrongRecipientSignature);

        auth.recipient = vm.addr(OTHER_KEY);
        vm.expectRevert(TeaClaimEscrow.InvalidSignature.selector);
        escrow.claim(auth, validIdentitySignature, validRecipientSignature);
        auth = _authorization(recipient);
        auth.amount++;
        _expectClaimRevert(auth, TeaClaimEscrow.InvalidAuthorization.selector);
        auth = _authorization(recipient);
        auth.identityCommitment = bytes32(uint256(1));
        _expectClaimRevert(auth, TeaClaimEscrow.InvalidAuthorization.selector);
        auth = _authorization(recipient);
        auth.token = address(0xBEEF);
        _expectClaimRevert(auth, TeaClaimEscrow.InvalidAuthorization.selector);
        auth = _authorization(recipient);
        auth.nonce++;
        _expectClaimRevert(auth, TeaClaimEscrow.InvalidAuthorization.selector);
    }

    function testDomainDeadlineAndRotationInvalidateSignatures() public {
        _deposit(100);
        TeaClaimEscrow.ClaimAuthorization memory auth = _authorization(recipient);
        bytes32 digest = escrow.authorizationDigest(auth);
        bytes memory identitySignature = _sign(SIGNER_KEY, digest);
        bytes memory recipientSignature = _sign(RECIPIENT_KEY, escrow.acceptanceDigest(digest));

        vm.chainId(block.chainid + 1);
        vm.expectRevert(TeaClaimEscrow.InvalidSignature.selector);
        escrow.claim(auth, identitySignature, recipientSignature);
        vm.chainId(block.chainid - 1);
        TeaClaimEscrow anotherEscrow = new TeaClaimEscrow(token, signer, address(this));
        assertTrue(anotherEscrow.authorizationDigest(auth) != digest);

        auth.deadline = uint64(block.timestamp - 1);
        _expectClaimRevert(auth, TeaClaimEscrow.InvalidAuthorization.selector);
        auth = _authorization(recipient);
        auth.deadline++;
        _expectClaimRevert(auth, TeaClaimEscrow.InvalidAuthorization.selector);

        escrow.rotateIdentitySigner(vm.addr(OTHER_KEY));
        TeaClaimEscrow.ClaimAuthorization memory oldEpochAuth = _authorizationWithOldEpoch();
        vm.expectRevert(TeaClaimEscrow.InvalidAuthorization.selector);
        escrow.claim(oldEpochAuth, identitySignature, recipientSignature);
        auth = _authorization(recipient);
        digest = escrow.authorizationDigest(auth);
        bytes memory newRecipientSignature = _sign(RECIPIENT_KEY, escrow.acceptanceDigest(digest));
        vm.expectRevert(TeaClaimEscrow.InvalidSignature.selector);
        escrow.claim(auth, identitySignature, newRecipientSignature);
    }

    function _authorizationWithOldEpoch() private view returns (TeaClaimEscrow.ClaimAuthorization memory auth) {
        auth = _authorization(recipient);
        auth.signerEpoch--;
    }

    function testExpiryBoundaryAndPausedRefundToPayer() public {
        _deposit(101);
        TeaClaimEscrow.ClaimAuthorization memory auth = _authorization(recipient);
        vm.expectRevert(TeaClaimEscrow.ClaimNotExpired.selector);
        escrow.refund(CLAIM_ID);
        vm.warp(1_000 + 14 days);
        _expectClaimRevert(auth, TeaClaimEscrow.ClaimExpired.selector);
        escrow.setPaused(true);
        vm.prank(address(0xBEEF));
        escrow.refund(CLAIM_ID);
        assertEq(token.balanceOf(payer), 1_000_000);
        assertEq(escrow.totalLiability(), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
        vm.expectRevert(TeaClaimEscrow.InvalidClaim.selector);
        escrow.refund(CLAIM_ID);
    }

    function testPauseAndOwnerRights() public {
        vm.prank(payer);
        vm.expectRevert();
        escrow.setPaused(true);
        escrow.setPaused(true);
        vm.prank(payer);
        vm.expectRevert();
        escrow.deposit(CLAIM_ID, COMMITMENT, 100);
        escrow.setPaused(false);
        _deposit(100);
        escrow.setPaused(true);
        _expectClaimRevert(_authorization(recipient), bytes4(keccak256("EnforcedPause()")));
    }

    function testRejectsDuplicateZeroAndFeeToken() public {
        vm.startPrank(payer);
        vm.expectRevert(TeaClaimEscrow.InvalidTerms.selector);
        escrow.deposit(bytes32(0), COMMITMENT, 1);
        vm.expectRevert(TeaClaimEscrow.InvalidTerms.selector);
        escrow.deposit(CLAIM_ID, bytes32(0), 1);
        vm.expectRevert(TeaClaimEscrow.InvalidTerms.selector);
        escrow.deposit(CLAIM_ID, COMMITMENT, 0);
        vm.stopPrank();
        token.setChargeFee(true);
        vm.prank(payer);
        vm.expectRevert(TeaClaimEscrow.UnsupportedToken.selector);
        escrow.deposit(CLAIM_ID, COMMITMENT, 100);
        assertEq(token.balanceOf(address(escrow)), 0);
        token.setChargeFee(false);
        _deposit(100);
        vm.prank(payer);
        vm.expectRevert(TeaClaimEscrow.InvalidTerms.selector);
        escrow.deposit(CLAIM_ID, COMMITMENT, 100);
        token.setChargeFee(true);
        _expectClaimRevert(_authorization(recipient), TeaClaimEscrow.UnsupportedToken.selector);
        assertEq(escrow.totalLiability(), 100);
        assertEq(token.balanceOf(address(escrow)), 100);
    }

    function testReentrantTokenCannotRefundDuringPayout() public {
        _deposit(100);
        token.configureReentry(escrow, CLAIM_ID);
        _claim(_authorization(recipient), RECIPIENT_KEY);
        assertTrue(token.reentryBlocked());
        assertEq(token.balanceOf(recipient), 100);
        assertEq(escrow.totalLiability(), 0);
    }

    function testFuzzTerminalPayoutConservesFunds(uint96 amount, bool recipientClaims) public {
        amount = uint96(bound(amount, 1, 1_000_000));
        _deposit(amount);
        assertEq(token.balanceOf(address(escrow)), escrow.totalLiability());
        if (recipientClaims) {
            _claim(_authorization(recipient), RECIPIENT_KEY);
            assertEq(token.balanceOf(recipient), amount);
        } else {
            vm.warp(1_000 + 14 days);
            escrow.refund(CLAIM_ID);
            assertEq(token.balanceOf(payer), 1_000_000);
        }
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalLiability(), 0);
    }

    function testConcurrentClaimsKeepLiabilitiesBacked() public {
        _deposit(100);
        bytes32 secondId = keccak256("claim 2");
        vm.prank(payer);
        escrow.deposit(secondId, keccak256("second identity"), 70);
        assertEq(escrow.totalLiability(), 170);
        _claim(_authorization(recipient), RECIPIENT_KEY);
        assertEq(token.balanceOf(address(escrow)), escrow.totalLiability());
        assertEq(escrow.totalLiability(), 70);
        vm.warp(1_000 + 14 days);
        escrow.refund(secondId);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalLiability(), 0);
        assertEq(token.balanceOf(payer), 1_000_000 - 100);
    }
}
