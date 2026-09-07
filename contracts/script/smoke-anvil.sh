#!/usr/bin/env bash
set -euo pipefail

rpc_url=${RPC_URL:-http://127.0.0.1:8545}
: "${TEA_TOKEN_ADDRESS:?set TEA_TOKEN_ADDRESS from LocalDeploy output}"
: "${TEA_STREAM_ADDRESS:?set TEA_STREAM_ADDRESS from LocalDeploy output}"

[[ $(cast chain-id --rpc-url "$rpc_url") == 31337 ]] || { echo 'Anvil chain ID 31337 required' >&2; exit 1; }
accounts=$(cast rpc eth_accounts --rpc-url "$rpc_url")
sender=$(jq -r '.[0]' <<< "$accounts")
recipient=$(jq -r '.[1]' <<< "$accounts")
[[ $sender == 0x* && $recipient == 0x* && $sender != "$recipient" ]] || { echo 'Two unlocked Anvil accounts required' >&2; exit 1; }

call() { cast call "$@" --rpc-url "$rpc_url" | cut -d ' ' -f 1; }
send() { cast send "$@" --from "$sender" --unlocked --rpc-url "$rpc_url" >/dev/null; }

sender_before=$(call "$TEA_TOKEN_ADDRESS" 'balanceOf(address)(uint256)' "$sender")
recipient_before=$(call "$TEA_TOKEN_ADDRESS" 'balanceOf(address)(uint256)' "$recipient")
liability_before=$(call "$TEA_STREAM_ADDRESS" 'totalLiability()(uint256)')
stream_id=$(call "$TEA_STREAM_ADDRESS" 'nextStreamId()(uint256)')

send "$TEA_TOKEN_ADDRESS" 'mint(address,uint256)' "$sender" 1000000
send "$TEA_TOKEN_ADDRESS" 'approve(address,uint256)' "$TEA_STREAM_ADDRESS" 1000000
send "$TEA_STREAM_ADDRESS" 'create(address,uint256,uint64)' "$recipient" 1000000 20
cast rpc evm_increaseTime 5 --rpc-url "$rpc_url" >/dev/null
cast rpc evm_mine --rpc-url "$rpc_url" >/dev/null
cast send "$TEA_STREAM_ADDRESS" 'withdraw(uint256)' "$stream_id" --from "$recipient" --unlocked --rpc-url "$rpc_url" >/dev/null
cast rpc evm_increaseTime 5 --rpc-url "$rpc_url" >/dev/null
cast rpc evm_mine --rpc-url "$rpc_url" >/dev/null
send "$TEA_STREAM_ADDRESS" 'cancel(uint256)' "$stream_id"
cast send "$TEA_STREAM_ADDRESS" 'withdraw(uint256)' "$stream_id" --from "$recipient" --unlocked --rpc-url "$rpc_url" >/dev/null

sender_after=$(call "$TEA_TOKEN_ADDRESS" 'balanceOf(address)(uint256)' "$sender")
recipient_after=$(call "$TEA_TOKEN_ADDRESS" 'balanceOf(address)(uint256)' "$recipient")
liability_after=$(call "$TEA_STREAM_ADDRESS" 'totalLiability()(uint256)')
remaining=$(call "$TEA_STREAM_ADDRESS" 'withdrawable(uint256)(uint256)' "$stream_id")

[[ $liability_after == "$liability_before" && $remaining == 0 ]] || { echo 'Unsettled stream liability' >&2; exit 1; }
(( sender_after - sender_before + recipient_after - recipient_before == 1000000 )) || { echo 'Funds did not reconcile' >&2; exit 1; }
echo "Anvil stream $stream_id: create, partial collect, cancel, final collect and balances verified"
