import { PublicKey, type Connection } from "@solana/web3.js";
import type { BalanceConnection } from "./summary";
import type { IndexerConnection } from "./indexer";

/**
 * Adapter from the project's shared RPC Connection to the structural
 * indexer/balance interfaces. Addresses are converted to PublicKey at the
 * boundary so the dashboard code can work with plain public-address strings.
 */
export function adaptConnection(conn: Connection): IndexerConnection & BalanceConnection {
  return {
    async getSignaturesForAddress(address, options) {
      return conn.getSignaturesForAddress(new PublicKey(address), { limit: options?.limit });
    },
    async getParsedTransaction(signature) {
      return conn.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
    },
    async getSignatureStatuses(signatures) {
      return conn.getSignatureStatuses(signatures);
    },
    async getBalance(address) {
      return conn.getBalance(new PublicKey(address), "confirmed");
    },
    async getTokenAccountsByOwner(owner, filter) {
      const resp = await conn.getTokenAccountsByOwner(new PublicKey(owner), {
        mint: new PublicKey(filter.mint),
      });
      return {
        value: resp.value.map((a) => ({ pubkey: String(a.pubkey) })),
      };
    },
    async getParsedAccountInfo(address) {
      return conn.getParsedAccountInfo(new PublicKey(address));
    },
  };
}