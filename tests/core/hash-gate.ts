// 核对密码用的哈希换成能卡住的（交给 HashQueue）：hold(n) 之后进来的 n 个停在“算哈希”这一步，
// release 才接着算，再往后的照常算。用来造“算哈希的空当”里发生别的事，不靠真实等待。calls 数进来过几次。
import { scryptAsync } from '../../server/accounts/password-hash.js';

export function hashGate() {
  let holding = 0,
    calls = 0;
  const parked: (() => void)[] = [],
    watchers: [count: number, done: () => void][] = [];
  return {
    hash: async (password: string, salt: string) => {
      calls++;
      for (const [count, done] of watchers) if (calls >= count) done();
      if (holding > 0) {
        holding--;
        await new Promise<void>((resume) => parked.push(resume));
      }
      return scryptAsync(password, salt);
    },
    get calls() {
      return calls;
    },
    hold(count = 1) {
      holding = count;
    },
    release() {
      holding = 0;
      parked.splice(0).forEach((resume) => resume());
    },
    /** 等到第 count 个核对走到算哈希这一步 */
    reached: (count: number) => new Promise<void>((done) => (calls >= count ? done() : watchers.push([count, done]))),
  };
}
