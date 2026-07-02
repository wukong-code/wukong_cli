// T8.4 driver: create session with explicit id, twice concurrently in same process.
import { createWukongHarness, type WukongHarness } from '@wukong/wukong-sdk';

const workDir = process.argv[2]!;
const homeDir = process.argv[3]!;
const sessionId = process.argv[4]!;

const identity: any = { userAgentProduct: 'wukong-cli', version: '0.0.1-test' };
const harnessA = createWukongHarness({ identity, homeDir });
const harnessB = createWukongHarness({ identity, homeDir });

async function run(label: string, h: WukongHarness): Promise<void> {
  try {
    const s = await h.createSession({ workDir, id: sessionId, model: 'wukong/wukong-for-coding' });
    console.log(JSON.stringify({ label, ok: true, id: s.id, dir: s.summary?.sessionDir }));
  } catch (error: any) {
    console.log(JSON.stringify({ label, ok: false, msg: String(error.message ?? error), code: error.code ?? error.cause?.code }));
  } finally {
    await h.close();
  }
}

await Promise.all([run('A', harnessA), run('B', harnessB)]);
