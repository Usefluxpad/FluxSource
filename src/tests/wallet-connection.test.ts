// @vitest-environment jsdom
/**
 * Wallet connection lifecycle tests.
 *
 * Covers the stuck-"Connecting…" regression: a hung adapter connect must be
 * bounded so the UI always recovers, and every failure must surface a
 * user-friendly error. Also guards against reintroducing any MetaMask/EVM
 * wallet integration into RelayPad's Solana-only runtime.
 */
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";
import {
  WalletConnectionError,
  WalletError,
  WalletNotReadyError,
  WalletReadyState,
  type Adapter,
} from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import {
  WALLET_CONNECT_TIMEOUT_MS,
  WalletConnectTimeoutError,
  describeWalletError,
  withConnectTimeout,
} from "@/lib/wallet/connect-lifecycle";

// RTL auto-cleanup requires global afterEach (vitest `globals` is off in this
// project) — unmount every rendered provider explicitly between tests.
afterEach(cleanup);

type ConnectBehavior = "resolve" | "reject" | "hang";

/** Minimal wallet-adapter-shaped test double driven by EventEmitter. */
class FakeWalletAdapter extends EventEmitter {
  readonly name: string;
  readonly url = "https://example.test/wallet";
  readonly icon = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
  readyState = WalletReadyState.Installed;
  connected = false;
  connectBehavior: ConnectBehavior;
  connectCalls = 0;
  disconnectCalls = 0;
  private pk: Keypair["publicKey"] | null = null;

  constructor(name: string, behavior: ConnectBehavior = "resolve") {
    super();
    this.name = name;
    this.connectBehavior = behavior;
  }

  get publicKey() {
    return this.pk;
  }

  async connect(): Promise<void> {
    this.connectCalls++;
    if (this.connectBehavior === "hang") return new Promise<void>(() => {});
    if (this.connectBehavior === "reject") {
      throw new WalletConnectionError("The user rejected the request");
    }
    this.pk = Keypair.generate().publicKey;
    this.connected = true;
    this.emit("connect", this.pk);
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.pk = null;
    this.connected = false;
    this.emit("disconnect");
  }

  async autoConnect(): Promise<boolean> {
    await this.connect();
    return this.connected;
  }
}

const asAdapter = (adapter: FakeWalletAdapter) => adapter as unknown as Adapter;

/** wallet-adapter-react brands wallet names; cast plain strings for tests. */
const walletName = (name: string) => name as unknown as string & { __brand__: "WalletName" };

function Probe() {
  const { publicKey, wallet, connecting, connect, disconnect, select } = useWallet();
  return createElement(
    "div",
    null,
    createElement(
      "span",
      { "data-testid": "state" },
      JSON.stringify({
        connected: !!publicKey,
        connecting,
        wallet: wallet?.adapter.name ?? null,
      }),
    ),
    createElement(
      "button",
      { "data-testid": "connect", onClick: () => void connect().catch(() => {}) },
      "connect",
    ),
    createElement(
      "button",
      { "data-testid": "disconnect", onClick: () => void disconnect() },
      "disconnect",
    ),
    createElement("button", { "data-testid": "select-a", onClick: () => select(walletName("FakeA")) }, "selectA"),
    createElement("button", { "data-testid": "select-b", onClick: () => select(walletName("FakeB")) }, "selectB"),
  );
}

function renderWalletHarness(
  wallets: Adapter[],
  opts: {
    autoConnect?: boolean;
    onError?: (error: WalletError) => void;
    localStorageKey?: string;
  } = {},
) {
  return render(
    // ts(2769): these providers type `children` as required, so it must live
    // inside the props object — disable the conflicting style rule here only.
    // eslint-disable-next-line react/no-children-prop
    createElement(ConnectionProvider, {
      endpoint: "http://127.0.0.1:8899",
      // eslint-disable-next-line react/no-children-prop
      children: createElement(
        WalletProvider,
        {
          wallets,
          autoConnect: opts.autoConnect ?? false,
          onError: opts.onError,
          localStorageKey: opts.localStorageKey ?? "testWalletName",
          children: createElement(Probe),
        },
      ),
    }),
  );
}

type HarnessState = { connected: boolean; connecting: boolean; wallet: string | null };

async function waitForState(pred: (s: HarnessState) => boolean) {
  await waitFor(() => {
    const raw = screen.getByTestId("state").textContent ?? "{}";
    const state = JSON.parse(raw) as HarnessState;
    expect(pred(state)).toBe(true);
  });
}

describe("withConnectTimeout", () => {
  it("lets a healthy connect resolve", async () => {
    const fake = new FakeWalletAdapter("FakeA", "resolve");
    const wrapped = withConnectTimeout(asAdapter(fake), { timeoutMs: 200 });
    await (wrapped.connect as unknown as () => Promise<void>)();
    expect(fake.connected).toBe(true);
  });

  it("bounds a hanging connect with a typed timeout error", async () => {
    const fake = new FakeWalletAdapter("FakeA", "hang");
    const wrapped = withConnectTimeout(asAdapter(fake), { timeoutMs: 80 });
    await expect(
      (wrapped.connect as unknown as () => Promise<void>)(),
    ).rejects.toBeInstanceOf(WalletConnectTimeoutError);
  });

  it("propagates the adapter's own rejection unchanged", async () => {
    const fake = new FakeWalletAdapter("FakeA", "reject");
    const wrapped = withConnectTimeout(asAdapter(fake), { timeoutMs: 200 });
    await expect(
      (wrapped.connect as unknown as () => Promise<void>)(),
    ).rejects.toMatchObject({ name: "WalletConnectionError" });
  });

  it("bounds autoConnect too", async () => {
    const fake = new FakeWalletAdapter("FakeA", "hang");
    const wrapped = withConnectTimeout(asAdapter(fake), { timeoutMs: 80 });
    await expect(
      (wrapped.autoConnect as unknown as () => Promise<boolean>)(),
    ).rejects.toBeInstanceOf(WalletConnectTimeoutError);
  });

  it("forwards adapter events and live getters through the wrapper", async () => {
    const fake = new FakeWalletAdapter("FakeA", "resolve");
    const wrapped = withConnectTimeout(asAdapter(fake), {
      timeoutMs: 200,
    }) as unknown as FakeWalletAdapter;
    const seen: string[] = [];
    wrapped.on("connect", () => seen.push("connect"));
    await wrapped.connect();
    expect(seen).toEqual(["connect"]);
    expect(wrapped.name).toBe("FakeA");
    expect(wrapped.publicKey).not.toBeNull();
  });
});

describe("describeWalletError", () => {
  it("maps timeouts, not-ready, rejections and window-closed to friendly copy", () => {
    expect(describeWalletError(new WalletConnectTimeoutError(60_000))).toContain("took too long");
    expect(describeWalletError(new WalletNotReadyError("not installed"))).toContain("not ready");
    expect(
      describeWalletError(new WalletConnectionError("The user rejected the request")),
    ).toContain("rejected");
    expect(
      describeWalletError(new WalletConnectionError("Wallet window closed")),
    ).toContain("window was closed");
    expect(describeWalletError(new WalletError("something odd"))).toBe("Wallet error: something odd");
  });
});

describe("wallet connection lifecycle (real WalletProvider)", () => {
  it("connects automatically when a wallet is selected (production select flow)", async () => {
    const fake = new FakeWalletAdapter("FakeA", "resolve");
    renderWalletHarness([asAdapter(fake)], { autoConnect: true });
    fireEvent.click(screen.getByTestId("select-a"));
    await waitForState((s) => s.connected && s.wallet === "FakeA" && !s.connecting);
    expect(fake.connectCalls).toBe(1);
  });

  it("a rejected connect resets the state and surfaces a friendly error", async () => {
    const fake = new FakeWalletAdapter("FakeA", "reject");
    const onConnectFailure = vi.fn();
    const wrapped = withConnectTimeout(asAdapter(fake), {
      timeoutMs: 5_000,
      onConnectFailure,
    });
    renderWalletHarness([wrapped], { autoConnect: true });
    fireEvent.click(screen.getByTestId("select-a"));
    await waitForState((s) => !s.connecting && !s.connected && s.wallet === null);
    expect(onConnectFailure).toHaveBeenCalledTimes(1);
    expect(onConnectFailure.mock.calls[0][0]).toBeInstanceOf(WalletConnectionError);
  });

  it("a hung connect is bounded: the UI recovers and a timeout error is reported", async () => {
    const fake = new FakeWalletAdapter("FakeA", "hang");
    const onConnectFailure = vi.fn();
    const wrapped = withConnectTimeout(asAdapter(fake), {
      timeoutMs: 100,
      onConnectFailure,
    });
    renderWalletHarness([wrapped], { autoConnect: true });
    fireEvent.click(screen.getByTestId("select-a"));
    await waitForState((s) => !s.connecting);
    await waitFor(() => expect(onConnectFailure).toHaveBeenCalled());
    expect(onConnectFailure.mock.calls[0][0]).toBeInstanceOf(WalletConnectTimeoutError);
    await waitForState((s) => !s.connected && s.wallet === null);
  });
});

describe("wallet connection lifecycle: reset, switching, repeat clicks", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("disconnect resets state and reconnecting works after re-selecting", async () => {
    const fake = new FakeWalletAdapter("FakeA", "resolve");
    renderWalletHarness([asAdapter(fake)], { autoConnect: true });
    fireEvent.click(screen.getByTestId("select-a"));
    await waitForState((s) => s.connected);
    fireEvent.click(screen.getByTestId("disconnect"));
    await waitForState((s) => !s.connected && s.wallet === null);
    expect(fake.disconnectCalls).toBeGreaterThanOrEqual(1);
    // Reconnect = re-select the wallet (wallet-adapter semantics after a
    // disconnect): the selection triggers a fresh bounded connect.
    fireEvent.click(screen.getByTestId("select-a"));
    await waitForState((s) => s.connected);
    expect(fake.connectCalls).toBe(2);
  });

  it("switching wallets disconnects the previous one and leaves no stale state", async () => {
    const a = new FakeWalletAdapter("FakeA", "resolve");
    const b = new FakeWalletAdapter("FakeB", "resolve");
    renderWalletHarness([asAdapter(a), asAdapter(b)], { autoConnect: true });
    fireEvent.click(screen.getByTestId("select-a"));
    await waitForState((s) => s.connected && s.wallet === "FakeA");
    fireEvent.click(screen.getByTestId("select-b"));
    await waitForState((s) => s.connected && s.wallet === "FakeB");
    expect(a.disconnectCalls).toBeGreaterThanOrEqual(1);
  });

  it("repeated connect attempts while connecting do not conflict", async () => {
    const fake = new FakeWalletAdapter("FakeA", "hang");
    const wrapped = withConnectTimeout(asAdapter(fake), {
      timeoutMs: 120,
      onConnectFailure: vi.fn(),
    });
    renderWalletHarness([wrapped], { autoConnect: true });
    fireEvent.click(screen.getByTestId("select-a"));
    fireEvent.click(screen.getByTestId("connect")); // second attempt mid-flight
    await waitForState((s) => !s.connecting);
    expect(fake.connectCalls).toBe(1); // the provider guards with isConnectingRef
  });
});

describe("wallet connection lifecycle: page refresh auto-connect", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("restores the stored wallet on refresh via bounded auto-connect", async () => {
    const fake = new FakeWalletAdapter("FakeA", "resolve");
    window.localStorage.setItem("testWalletName", JSON.stringify("FakeA"));
    renderWalletHarness([asAdapter(fake)], {
      autoConnect: true,
      localStorageKey: "testWalletName",
    });
    await waitForState((s) => s.connected && !s.connecting);
  });

  it("a hung stored wallet cannot stay stuck on refresh", async () => {
    const fake = new FakeWalletAdapter("FakeA", "hang");
    const onConnectFailure = vi.fn();
    const wrapped = withConnectTimeout(asAdapter(fake), {
      timeoutMs: 100,
      onConnectFailure,
    });
    window.localStorage.setItem("testWalletName", JSON.stringify("FakeA"));
    renderWalletHarness([wrapped], {
      autoConnect: true,
      localStorageKey: "testWalletName",
    });
    await waitForState((s) => !s.connecting);
    await waitFor(() => expect(onConnectFailure).toHaveBeenCalled());
    expect(onConnectFailure.mock.calls[0][0]).toBeInstanceOf(WalletConnectTimeoutError);
  });
});

describe("Solana-only runtime", () => {
  it("contains no EVM wallet integration in FluxPad code or runtime", () => {
    const collect = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === "tests") continue;
          collect(full, out);
        } else if (/\.(ts|tsx)$/.test(entry)) {
          out.push(full);
        }
      }
      return out;
    };
    const files = collect(join(process.cwd(), "src"));
    expect(files.length).toBeGreaterThan(20);
    // Banned: EVM libraries, the injected EVM provider handle, and the
    // Solflare-in-MetaMask Snap bridge (package + its runtime probe strings).
    // The bundled adapter packages that carried that bridge are also banned
    // from import so the bridge can never re-enter the runtime bundle.
    const banned = [
      /window\.ethereum/i,
      /wagmi/i,
      /\bviem\b/i,
      /\bethers\b/i,
      /metamask-sdk/i,
      /wallet_getSnaps/i,
      /metamask-contentscript/i,
      /wallet-adapter-solflare/i,
    ];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const pattern of banned) {
        expect(pattern.test(content), `${file} must not reference EVM integration (${pattern})`).toBe(false);
      }
    }
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const evm = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) =>
      /metamask|wagmi|viem|ethers/i.test(name),
    );
    expect(evm).toEqual([]);
    // Supported Solana wallets: Phantom (official adapter) and Solflare (the
    // vendored Solana-only adapter, which runs on the Solflare SDK).
    expect(Object.keys(pkg.dependencies)).toContain("@solana/wallet-adapter-phantom");
    // The Solflare runtime SDK must be installed (today as the transitive
    // dep of the still-declared adapter package; promoted to a direct dep at
    // the next dependency cleanup together with removing that package).
    expect(existsSync(join(process.cwd(), "node_modules/@solflare-wallet/sdk"))).toBe(true);
  });

  it("serves Solflare through the vendored Solana-only adapter", () => {
    const provider = readFileSync(join(process.cwd(), "src/components/wallet/wallet-providers.tsx"), "utf8");
    expect(provider).toContain("@/lib/wallet/solflare-adapter");
    expect(provider).toContain("new SolflareWalletAdapter(");
    expect(provider).toContain("new PhantomWalletAdapter(");
    const vendored = readFileSync(join(process.cwd(), "src/lib/wallet/solflare-adapter.ts"), "utf8");
    expect(vendored).toContain("SolflareWalletName");
    // The vendored adapter must load the real Solflare SDK lazily on connect.
    expect(vendored).toContain("@solflare-wallet/sdk")
  });

  it("keeps a generous production connection timeout (longer than human approval)", () => {
    expect(WALLET_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});


