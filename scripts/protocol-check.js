/*
 * Dev tooling: protocol verification for FluxPad (devnet only).
 * - Verifies devnet RPC reachability.
 * - Pump route: live Global config load, offline create_v2 transaction
 *   construction + local mint signing (NO submission).
 * - LaunchLab route: live config account check on the devnet program,
 *   typed-failure verification when the config is absent, curve-read behavior
 *   for an unknown mint.
 * No transactions are submitted and no funds are spent.
 */
const {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram,
} = require("@solana/web3.js");
const pump = require("@pump-fun/pump-sdk");
const ray = require("@raydium-io/raydium-sdk-v2");
const { NATIVE_MINT } = require("@solana/spl-token");

const log = (...a) => console.log(...a);

function typedCheck(name, fn) {
  return fn()
    .then((r) => ({ name, ok: true, result: r }))
    .catch((e) => ({ name, ok: false, error: String(e && e.message ? e.message : e) }));
}

(async () => {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");

  // 0) devnet reachability
  let slot;
  try {
    slot = await connection.getSlot("confirmed");
    log("DEVNET_REACHABLE slot=" + slot);
  } catch (e) {
    log("DEVNET_UNREACHABLE " + e.message);
    process.exit(1);
  }
// __PART2__

  // 1) Pump: live Global config
  const pumpConfig = await typedCheck("PUMP_LOAD_CONFIG", async () => {
    const online = new pump.OnlinePumpSdk(connection);
    const g = await online.fetchGlobal();
    return {
      programId: pump.PUMP_PROGRAM_ID.toBase58(),
      feeBasisPoints: g.feeBasisPoints.toString(),
      createV2Enabled: Boolean(g.createV2Enabled),
      initialVirtualSolReserves: g.initialVirtualSolReserves.toString(),
    };
  });
  log("PUMP_LOAD_CONFIG ok=" + pumpConfig.ok, pumpConfig.ok ? JSON.stringify(pumpConfig.result) : pumpConfig.error);

  // 2) Pump: create_v2 transaction construction (offline builder) + local mint signing
  const pumpBuild = await typedCheck("PUMP_BUILD_TX", async () => {
    const mintKp = Keypair.generate();
    const user = Keypair.generate().publicKey;
    const ix = await pump.PUMP_SDK.createV2Instruction({
      mint: mintKp.publicKey,
      name: "FluxPad Verification",
      symbol: "RPV",
      uri: "https://ipfs.io/ipfs/fluxpad-verification.json",
      creator: user,
      user,
      mayhemMode: false,
      holderReward: false,
    });
    if (!ix.programId.equals(pump.PUMP_PROGRAM_ID)) {
      throw new Error("instruction program id mismatch");
    }
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
    const tx = new Transaction({ feePayer: user, blockhash, lastValidBlockHeight });
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
    tx.add(ix);
    tx.partialSign(mintKp);
    const msg = tx.serializeMessage(); // throws if malformed
    const present = tx.signatures.filter((s) => s && s.signature).length;
    return {
      programId: ix.programId.toBase58(),
      serializedMessageBytes: msg.length,
      locallyAttachedSignatures: present,
      mintAddress: mintKp.publicKey.toBase58(),
    };
  });
  log("PUMP_BUILD_TX ok=" + pumpBuild.ok, pumpBuild.ok ? JSON.stringify(pumpBuild.result) : pumpBuild.error);

  // 2b) Pump: simulation of the built tx with an UNFUNDED payer (devnet).
  // Expected: simulation executes and fails with an insufficient-funds style
  // error — proving the simulation path surfaces on-chain errors honestly.
  const pumpSim = await typedCheck("PUMP_SIMULATE_UNFUNDED", async () => {
    const mintKp = Keypair.generate();
    const payer = Keypair.generate(); // 0 lamports by design
    const ix = await pump.PUMP_SDK.createV2Instruction({
      mint: mintKp.publicKey,
      name: "FluxPad Simulation",
      symbol: "RPS",
      uri: "https://ipfs.io/ipfs/fluxpad-simulation.json",
      creator: payer.publicKey,
      user: payer.publicKey,
      mayhemMode: false,
      holderReward: false,
    });
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight });
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
    tx.add(ix);
    tx.sign(mintKp); // only the mint signs; payer is unfunded
    const sim = await connection.simulateTransaction(tx);
    const err = sim.value.err ? JSON.stringify(sim.value.err) : null;
    return { simulated: true, failed: Boolean(sim.value.err), err, logTail: (sim.value.logs || []).slice(-3) };
  });
  log("PUMP_SIMULATE_UNFUNDED ok=" + pumpSim.ok, pumpSim.ok ? JSON.stringify(pumpSim.result) : pumpSim.error);

  // 3) Pump: curve state read for an unknown mint must fail with a typed error
  const pumpCurve = await typedCheck("PUMP_CURVE_READ_UNKNOWN", async () => {
    const info = await connection.getAccountInfo(pump.bondingCurvePda(Keypair.generate().publicKey));
    if (!info) throw new Error("PROTOCOL: bonding curve account not found (expected for unknown mint)");
    return "unexpected: account existed";
  });
  log("PUMP_CURVE_READ_UNKNOWN ok=" + pumpCurve.ok, pumpCurve.error || "");

  // 4) LaunchLab: live config account on the devnet program
  const labProgram = ray.DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM;
  const configId = ray.getPdaLaunchpadConfigId(labProgram, NATIVE_MINT, 0, 0).publicKey;
  let labConfigData = null;
  try {
    labConfigData = await connection.getAccountInfo(configId, "confirmed");
  } catch (e) {
    log("LAB_CONFIG_FETCH_ERROR " + e.message);
  }
  if (labConfigData) {
    const cfg = ray.LaunchpadConfig.decode(labConfigData.data);
    log("LAB_CONFIG_FOUND", JSON.stringify({
      programId: labProgram.toBase58(),
      configId: configId.toBase58(),
      mintB: cfg.mintB.toBase58(),
      curveType: Number(cfg.curveType),
      tradeFeeRate: cfg.tradeFeeRate.toString(),
      minFundRaisingB: cfg.minFundRaisingB.toString(),
    }));
  } else {
    log(
      "LAB_CONFIG_ABSENT",
      JSON.stringify({
        programId: labProgram.toBase58(),
        configId: configId.toBase58(),
        verdict:
          "LaunchLab devnet config (SOL quote, curve 0, index 0) not deployed on this cluster — the adapter must fail with a typed PROTOCOL error and the UI must show the route as unavailable.",
      }),
    );
  }

  // 5) LaunchLab: curve-state read for an unknown mint (both cluster programs)
  const labCurve = await typedCheck("LAB_CURVE_READ_UNKNOWN", async () => {
    const mint = Keypair.generate().publicKey;
    for (const pid of [ray.LAUNCHPAD_PROGRAM, ray.DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM]) {
      const poolId = ray.getPdaLaunchpadPoolId(pid, mint, NATIVE_MINT).publicKey;
      const info = await connection.getAccountInfo(poolId, "confirmed");
      if (info) return "unexpected: state existed";
    }
    throw new Error("PROTOCOL: no LaunchLab curve account found (expected for unknown mint)");
  });
  log("LAB_CURVE_READ_UNKNOWN ok=" + labCurve.ok, labCurve.error || "");

  // 6) LaunchLab: real transaction construction against the live devnet config
  //    (SDK builds the transactions; nothing is executed or submitted).
  if (labConfigData) {
    const labBuild = await typedCheck("LAB_BUILD_TX", async () => {
      const cfg = ray.LaunchpadConfig.decode(labConfigData.data);
      const owner = Keypair.generate().publicKey; // wallet-adapter style: public key only
      const mintKp = Keypair.generate();
      const raydium = await ray.Raydium.load({
        owner,
        connection,
        cluster: "devnet",
        disableFeatureCheck: true,
        blockhashCommitment: "finalized",
      });
      const { transactions } = await raydium.launchpad.createLaunchpad({
        programId: labProgram,
        platformId: ray.DEVNET_PROGRAM_ID.LAUNCHPAD_PLATFORM,
        mintA: mintKp.publicKey,
        decimals: 6,
        name: "FluxPad Verification",
        symbol: "RPV",
        uri: "https://ipfs.io/ipfs/fluxpad-verification.json",
        migrateType: "cpmm",
        configId,
        configInfo: cfg,
        mintBDecimals: 9,
        mintBProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        createOnly: true,
        buyAmount: new (require("bn.js"))(0),
        slippage: new (require("bn.js"))(100),
        txVersion: ray.TxVersion.V0,
        extraSigners: [mintKp],
      });
      if (!transactions || transactions.length === 0) throw new Error("no transactions built");
      const first = transactions[0];
      const header = first.message.header;
      const keys = first.message.staticAccountKeys.map((k) => k.toBase58());
      return {
        transactionCount: transactions.length,
        numRequiredSignatures: header.numRequiredSignatures,
        includesMint: keys.includes(mintKp.publicKey.toBase58()),
        includesLaunchlabProgram: keys.includes(labProgram.toBase58()),
        version: first.version,
        mintAddress: mintKp.publicKey.toBase58(),
      };
    });
    log("LAB_BUILD_TX ok=" + labBuild.ok, labBuild.ok ? JSON.stringify(labBuild.result) : labBuild.error);
  } else {
    log(
      "LAB_BUILD_TX not_attempted: honest limitation — createLaunchpad requires a live GlobalConfig; constructing a transaction against an absent config would be fabrication.",
    );
  }

  log("DONE");
})().catch((e) => {
  log("FATAL", String(e));
  process.exit(1);
});
