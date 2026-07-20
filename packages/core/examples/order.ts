// Order-processing demo for the workflow engine.
//
//   bun packages/core/examples/order.ts start            happy path
//   bun packages/core/examples/order.ts start --crash    process dies mid-payment
//   bun packages/core/examples/order.ts resume <runId>   continue from the checkpoint
//   bun packages/core/examples/order.ts cancel <runId>
//   bun packages/core/examples/order.ts log <runId>
//
// State lives in examples/order.db, so a crashed run survives the process and
// `resume` picks it up: reserve-inventory is memoized (its log line does not
// appear again), only the interrupted payment step re-executes.

import { Database } from "bun:sqlite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { WorkflowDb } from "../src/index.ts";
import {
  createEngine,
  defineStep,
  defineWorkflow,
  workflowEvents,
  workflowRuns,
  workflowSchema,
  workflowSteps,
} from "../src/index.ts";

const crashRequested = process.argv.includes("--crash");

const reserveInventory = defineStep(
  "reserve-inventory",
  async ({ sku, quantity }: { sku: string; quantity: number }) => {
    console.log(`  [step] reserving ${quantity} × ${sku}`);
    await Bun.sleep(300);
    return { reservationId: `res_${sku}_${quantity}` };
  },
);

let paymentAttemptsThisProcess = 0;
const chargePayment = defineStep(
  "charge-payment",
  async ({
    orderId,
    amountCents,
  }: {
    orderId: string;
    amountCents: number;
  }) => {
    paymentAttemptsThisProcess += 1;
    console.log(
      `  [step] charging $${(amountCents / 100).toFixed(2)} for ${orderId} (attempt ${paymentAttemptsThisProcess})`,
    );
    await Bun.sleep(300);
    if (crashRequested) {
      console.log("  [step] 💥 simulating a hard process crash mid-payment");
      process.exit(1);
    }
    // The gateway "times out" once per process, so every fresh execution
    // shows a step_retrying event before succeeding.
    if (paymentAttemptsThisProcess === 1) {
      throw new Error("payment gateway timeout");
    }
    return { chargeId: `ch_${orderId}` };
  },
  { maxAttempts: 3, initialDelayMs: 200 },
);

const createShippingLabel = defineStep(
  "create-shipping-label",
  async ({ orderId, address }: { orderId: string; address: string }) => {
    console.log(`  [step] creating label for ${orderId} → ${address}`);
    await Bun.sleep(200);
    return { trackingNumber: `TRK-${orderId.toUpperCase()}` };
  },
);

const notifyCarrier = defineStep(
  "notify-carrier",
  async ({ trackingNumber }: { trackingNumber: string }) => {
    console.log(`  [step] notifying carrier about ${trackingNumber}`);
    await Bun.sleep(200);
    return { notified: true };
  },
);

const sendReceipt = defineStep(
  "send-receipt",
  async ({ orderId, chargeId }: { orderId: string; chargeId: string }) => {
    console.log(`  [step] sending receipt for ${orderId} (${chargeId})`);
    await Bun.sleep(200);
    return { receiptId: `rcpt_${orderId}` };
  },
);

const shipOrder = defineWorkflow(
  "ship-order",
  async (ctx, input: { orderId: string; address: string }) => {
    const label = await ctx.step(createShippingLabel, input);
    await ctx.step(notifyCarrier, { trackingNumber: label.trackingNumber });
    return { trackingNumber: label.trackingNumber };
  },
);

const processOrder = defineWorkflow(
  "process-order",
  async (
    ctx,
    input: {
      orderId: string;
      sku: string;
      quantity: number;
      amountCents: number;
      address: string;
    },
  ) => {
    const reservation = await ctx.step(reserveInventory, {
      sku: input.sku,
      quantity: input.quantity,
    });
    const charge = await ctx.step(chargePayment, {
      orderId: input.orderId,
      amountCents: input.amountCents,
    });
    const shipment = await ctx.child(shipOrder, {
      orderId: input.orderId,
      address: input.address,
    });
    const receipt = await ctx.step(sendReceipt, {
      orderId: input.orderId,
      chargeId: charge.chargeId,
    });
    return {
      orderId: input.orderId,
      reservationId: reservation.reservationId,
      chargeId: charge.chargeId,
      trackingNumber: shipment.trackingNumber,
      receiptId: receipt.receiptId,
    };
  },
);

async function printRun(
  db: WorkflowDb,
  runId: string,
  indent = "",
): Promise<void> {
  const run = (
    await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1)
  ).at(0);
  if (!run) {
    console.log(`${indent}no run "${runId}"`);
    return;
  }
  console.log(`${indent}run ${run.id} [${run.workflowName}] → ${run.status}`);
  if (run.output !== null) console.log(`${indent}  output: ${run.output}`);
  if (run.error !== null) console.log(`${indent}  error:  ${run.error}`);
  const steps = await db
    .select()
    .from(workflowSteps)
    .where(eq(workflowSteps.runId, runId))
    .orderBy(asc(workflowSteps.seq));
  for (const step of steps) {
    const child = step.childRunId === null ? "" : ` child=${step.childRunId}`;
    console.log(
      `${indent}  step ${step.seq} ${step.name} → ${step.status} (attempts ${step.attempts})${child}`,
    );
  }
  const events = await db
    .select()
    .from(workflowEvents)
    .where(eq(workflowEvents.runId, runId))
    .orderBy(asc(workflowEvents.id));
  for (const event of events) {
    const seq = event.seq === null ? "" : ` seq=${event.seq}`;
    const data = event.data === null ? "" : ` ${event.data}`;
    console.log(`${indent}  #${event.id} ${event.type}${seq}${data}`);
  }
  const children = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.parentRunId, runId));
  for (const childRun of children) {
    console.log("");
    await printRun(db, childRun.id, `${indent}  `);
  }
}

const script = process.argv[1] ?? "packages/core/examples/order.ts";
const [command = "start", runIdArg] = process.argv
  .slice(2)
  .filter((arg) => arg !== "--crash");

const sqlite = new Database(`${import.meta.dir}/order.db`);
const db = drizzle(sqlite, { schema: workflowSchema });
migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });
const engine = createEngine({ db, workflows: [processOrder, shipOrder] });

switch (command) {
  case "start": {
    const orderId = `ord_${crypto.randomUUID().slice(0, 8)}`;
    const handle = await engine.start(processOrder, {
      orderId,
      sku: "WOLLI-TEE",
      quantity: 2,
      amountCents: 4900,
      address: "Rustaveli Ave 12, Tbilisi",
    });
    console.log(`started run ${handle.runId}`);
    console.log(`  resume later with: bun ${script} resume ${handle.runId}\n`);
    try {
      console.log("\ncompleted:", await handle.result());
    } catch (error) {
      console.log(`\nrun failed: ${error}`);
    }
    console.log("");
    await printRun(db, handle.runId);
    break;
  }
  case "resume": {
    if (runIdArg === undefined) {
      console.log(`usage: bun ${script} resume <runId>`);
      process.exitCode = 1;
      break;
    }
    const handle = await engine.resume(runIdArg);
    try {
      console.log("\ncompleted:", await handle.result());
    } catch (error) {
      console.log(`\nrun failed: ${error}`);
    }
    console.log("");
    await printRun(db, runIdArg);
    break;
  }
  case "cancel": {
    if (runIdArg === undefined) {
      console.log(`usage: bun ${script} cancel <runId>`);
      process.exitCode = 1;
      break;
    }
    await engine.cancel(runIdArg);
    await printRun(db, runIdArg);
    break;
  }
  case "log": {
    if (runIdArg === undefined) {
      console.log(`usage: bun ${script} log <runId>`);
      process.exitCode = 1;
      break;
    }
    await printRun(db, runIdArg);
    break;
  }
  default: {
    console.log(
      `usage: bun ${script} [start [--crash] | resume <runId> | cancel <runId> | log <runId>]`,
    );
    process.exitCode = 1;
  }
}
