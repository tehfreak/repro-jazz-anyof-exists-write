import { schema as s } from "jazz-tools";
import { allOf, anyOf, definePermissions } from "jazz-tools/permissions";
import { createPolicyTestApp } from "jazz-tools/testing";

const app = s.defineApp({
  gate_a: s.table({ key: s.string() }),
  gate_b: s.table({ key: s.string() }),
  docs: s.table({ title: s.string() }),
});

const both = ({ policy, session }: any) => [
  policy.gate_a.exists.where({ key: session.user_id }),
  policy.gate_b.exists.where({ key: session.user_id }),
];

function tryInsert(db: any): "allowed" | "denied" | string {
  const tx = db.beginTransaction();
  try {
    tx.insert(app.docs, { title: "x" });
    tx.rollback();
    return "allowed";
  } catch (e) {
    tx.rollback();
    const message = String((e as Error).message ?? e);
    return message.includes("policy denied") ? "denied" : "error: " + message;
  }
}

const noopExpect = () => ({ toThrow() {}, not: { toThrow() {} } });

async function run(build: (ctx: any) => any, seedGateB: boolean): Promise<string> {
  const permissions = definePermissions(app, ({ policy, session }: any) => {
    policy.docs.allowInsert.where(build({ policy, session }));
    policy.gate_a.allowInsert.where(allOf([]));
    policy.gate_b.allowInsert.where(allOf([]));
    policy.gate_a.allowRead.where(allOf([]));
    policy.gate_b.allowRead.where(allOf([]));
    policy.docs.allowRead.where(allOf([]));
  });

  const testApp = await createPolicyTestApp(app as any, permissions, noopExpect as any);
  try {
    testApp.seed((db: any) => {
      db.insert(app.gate_a, { key: "alice" });
      if (seedGateB) db.insert(app.gate_b, { key: "alice" });
    });
    const alice = testApp.as({ user_id: "alice", claims: {}, authMode: "local-first" } as any);
    return tryInsert(alice);
  } finally {
    await testApp.shutdown();
  }
}

async function main(): Promise<void> {
  const single = await run(
    ({ policy, session }: any) => policy.gate_a.exists.where({ key: session.user_id }),
    false,
  );
  const anyOfOne = await run((ctx: any) => anyOf(both(ctx)), false);
  const allOfOne = await run((ctx: any) => allOf(both(ctx)), false);
  const allOfBoth = await run((ctx: any) => allOf(both(ctx)), true);

  const rows = [
    ["single exists, gate_a seeded", "allowed", single],
    ["anyOf([gate_a, gate_b]), gate_a seeded", "allowed", anyOfOne],
    ["allOf([gate_a, gate_b]), gate_a seeded", "denied", allOfOne],
    ["allOf([gate_a, gate_b]), both seeded", "allowed", allOfBoth],
  ] as const;

  for (const [label, want, got] of rows) {
    const mark = want === got ? "ok " : "BUG";
    console.log(`${mark}  ${label.padEnd(40)} want ${want.padEnd(8)} got ${got}`);
  }

  const broken =
    single === "allowed" &&
    anyOfOne === "denied" &&
    allOfOne === "denied" &&
    allOfBoth === "allowed";

  console.log("");
  console.log(`VERDICT: ${broken ? "BROKEN" : "WORKS"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
