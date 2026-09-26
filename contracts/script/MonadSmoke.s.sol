// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {TeaClaimEscrow} from "../src/TeaClaimEscrow.sol";
import {TeaDateUnlock} from "../src/TeaDateUnlock.sol";
import {TeaStream} from "../src/TeaStream.sol";
import {TestUSD} from "../src/TestUSD.sol";

contract MonadSmokeScript is Script {
    uint256 private constant UNIT = 1_000_000;

    function run() external {
        require(block.chainid == 10143, "Monad testnet only");

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address actor = vm.addr(deployerKey);
        TestUSD token = TestUSD(vm.envAddress("SETTLEMENT_TOKEN"));
        TeaStream stream = TeaStream(vm.envAddress("TEA_STREAM_ADDRESS"));
        TeaClaimEscrow escrow = TeaClaimEscrow(vm.envAddress("CLAIM_ESCROW_ADDRESS"));
        TeaDateUnlock dateUnlock = TeaDateUnlock(vm.envAddress("TEA_DATE_UNLOCK_ADDRESS"));
        address sink = address(0x000000000000000000000000000000000000bEEF);

        vm.startBroadcast(deployerKey);
        token.mint(actor, 10 * UNIT);
        require(token.transfer(sink, UNIT), "transfer failed");

        token.approve(address(stream), 3 * UNIT);
        uint256 fastStreamId = stream.create(actor, UNIT, 1);
        uint256 canceledStreamId = stream.create(actor, UNIT, 1 hours);
        stream.cancel(canceledStreamId);

        token.approve(address(escrow), UNIT);
        bytes32 claimId = keccak256(abi.encodePacked("tea-smoke-claim", block.chainid, block.timestamp, actor));
        bytes32 commitment = keccak256(abi.encodePacked("tea-smoke-commitment", claimId));
        escrow.deposit(claimId, commitment, UNIT);
        TeaClaimEscrow.ClaimAuthorization memory authorization = TeaClaimEscrow.ClaimAuthorization({
            claimId: claimId,
            identityCommitment: commitment,
            token: address(token),
            amount: UNIT,
            recipient: actor,
            nonce: escrow.nonces(claimId),
            deadline: uint64(block.timestamp + 5 minutes),
            signerEpoch: escrow.signerEpoch()
        });
        bytes memory identitySignature = _signature(deployerKey, escrow.authorizationDigest(authorization));
        bytes memory recipientSignature =
            _signature(deployerKey, escrow.acceptanceDigest(escrow.authorizationDigest(authorization)));
        escrow.claim(authorization, identitySignature, recipientSignature);

        token.approve(address(dateUnlock), UNIT);
        uint256 lockId = dateUnlock.create(actor, UNIT, uint64(block.timestamp + 1 hours));
        vm.stopBroadcast();

        console2.log("Actor", actor);
        console2.log("FastStreamId", fastStreamId);
        console2.log("CanceledStreamId", canceledStreamId);
        console2.log("ClaimId");
        console2.logBytes32(claimId);
        console2.log("DateLockId", lockId);
    }

    function _signature(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
