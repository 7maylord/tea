import { Injectable } from '@nestjs/common';
import type { IndexedEvent } from '../payments/indexed-receipt';

type GraphqlPayload<T> = { data?: T; errors?: unknown[] };
type LatestEvent = {
  blockNumber: string;
  blockHash: string;
  blockTimestamp: string;
  txHash: string;
};

@Injectable()
export class IndexerService {
  private get config() {
    const url = process.env.ENVIO_GRAPHQL_URL;
    if (!url) return null;
    return { url, secret: process.env.ENVIO_ADMIN_SECRET };
  }

  private async query<T>(query: string, variables?: Record<string, unknown>) {
    const config = this.config;
    if (!config) return { available: false, data: null as T | null };
    try {
      const response = await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.secret ? { 'x-hasura-admin-secret': config.secret } : {}),
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error('Indexer unavailable');
      const payload = (await response.json()) as GraphqlPayload<T>;
      if (payload.errors?.length || !payload.data) {
        throw new Error('Indexer response invalid');
      }
      return { available: true, data: payload.data };
    } catch {
      return { available: false, data: null as T | null };
    }
  }

  async eventsByHashes(hashes: string[]) {
    const unique = [...new Set(hashes.map((hash) => hash.toLowerCase()))];
    if (unique.length === 0) {
      return { available: !!this.config, events: [] as IndexedEvent[] };
    }
    const result = await this.query<{ ChainEvent: IndexedEvent[] }>(
      `query($hashes: [String!]!) {
        ChainEvent(where: {txHash: {_in: $hashes}}, limit: 100) {
          id chainId txHash logIndex blockNumber blockHash contractAddress
          eventType fromAddress toAddress amountUnits streamId claimId lockId unlockAt
        }
      }`,
      { hashes: unique },
    );
    return {
      available: result.available,
      events: Array.isArray(result.data?.ChainEvent)
        ? result.data.ChainEvent
        : [],
    };
  }

  async status() {
    const configured = !!this.config;
    const result = await this.query<{ ChainEvent: LatestEvent[] }>(
      `query {
        ChainEvent(limit: 1, order_by: {blockNumber: desc, logIndex: desc}) {
          blockNumber blockHash blockTimestamp txHash
        }
      }`,
    );
    const latest = result.data?.ChainEvent?.[0] ?? null;
    return {
      configured,
      available: result.available,
      latest: latest
        ? {
            blockNumber: latest.blockNumber,
            blockHash: latest.blockHash,
            blockTimestamp: latest.blockTimestamp,
            txHash: latest.txHash,
          }
        : null,
    };
  }
}
