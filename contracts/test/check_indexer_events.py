"""Run after forge build: reject ABI drift or missing Envio lifecycle handlers."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
config = (root / 'indexer/config.yaml').read_text()
handlers = (root / 'indexer/src/handlers/events.ts').read_text()
required = {
    'TeaDateUnlock': ['LockCreated', 'LockWithdrawn'],
    'TeaStream': ['StreamCreated', 'StreamWithdrawn', 'StreamCanceled'],
    'TeaClaimEscrow': ['ClaimDeposited', 'ClaimPaid', 'ClaimRefunded'],
}
for contract, names in required.items():
    built = json.loads((root / f'contracts/out/{contract}.sol/{contract}.json').read_text())['abi']
    tracked = json.loads((root / f'contracts/abi/{contract}.json').read_text())
    assert built == tracked, f'{contract}: exported ABI is stale'
    events = {entry['name']: entry for entry in built if entry['type'] == 'event'}
    for name in names:
        inputs = events[name]['inputs']
        signature = name + '(' + ', '.join(
            item['type'] + (' indexed' if item['indexed'] else '') + ' ' + item['name']
            for item in inputs
        ) + ')'
        assert f'event: "{signature}"' in config, f'Envio declaration differs: {signature}'
        assert f"contract: '{contract}', event: '{name}'" in handlers, f'Missing handler: {name}'
assert 'event: "Transfer(address indexed from, address indexed to, uint256 value)"' in config
assert "contract: 'SettlementToken', event: 'Transfer'" in handlers
print('ABIs and all nine payment lifecycle subscriptions agree.')
