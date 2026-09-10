import { createEmbedder, cosineSimilarity } from '../server/ai/embeddings';
import { loadEmbedding } from '../server/config';

/**
 * Checks a configured embedding provider for real. Two things go wrong in practice, and neither
 * shows up until the knowledge base is already full of vectors that cannot be used:
 *
 *  1. the provider ignores the requested `dimensions` and returns its own, which will not fit
 *     the column the database was built with;
 *  2. the endpoint answers, but the vectors carry no usable meaning for the language in use.
 *
 * The passages are transcript-length on purpose. A one-sentence corpus is a much harder problem
 * than the real one — chunks here are around 350 tokens — and failing on it would send you
 * chasing a provider that would have worked fine.
 *
 * Makes about a dozen real requests against the configured account. Small, but not free.
 */

const PASSAGES = [
  `So the thing people get wrong about compound growth is that they obsess over the rate. They
   will spend a weekend comparing one fund against another because one of them is half a percent
   better. That half a percent is not nothing, but it is nowhere near the biggest lever you have.
   The biggest lever is time. If you start putting money away at twenty two and stop at thirty
   two, and someone else starts at thirty two and keeps going until sixty five, in a lot of
   scenarios you still come out ahead, having contributed for ten years instead of thirty three.
   The early contributions get multiplied by every year that follows them; the late ones do not.`,
  `什么叫复习间隔要拉长？很多人背单词是每天全部过一遍，这样最花时间，效果反而一般。真正管用的做法是：刚记住的东西第二天再看一次，
   记牢了就把下一次推到三天后、一周后、一个月后。你只在快要忘掉的那个点上复习，每一次复习都把记忆的保持时间往后拉一大截，
   总的复习次数反而少了。关键是间隔要根据你自己答对答错来调整，而不是所有内容用同一个节奏。`,
  `The reason the transformer was such a big deal is that the recurrent models before it had to
   process a sequence one step at a time, and information from the beginning of a long sentence
   had to survive being passed through every intermediate step to reach the end. In practice it
   degraded. Attention throws that out. Every position gets to look directly at every other
   position in a single operation, so the distance between two related words stops mattering.`,
];
/** Paraphrases that share almost no vocabulary with their target: lexical overlap would let an
 *  embedding that understood nothing pass this check. */
const PROBES = [
  { query: 'why does starting to save early help so much', expect: 0 },
  { query: '怎么安排复习时间才不容易忘', expect: 1 },
  { query: 'how does a model relate words that are far apart', expect: 2 },
];
/** Should match nothing. Reports the score floor, which is what makes a threshold unsafe. */
const UNRELATED = 'what time does the hardware store close on Sunday';

const config = loadEmbedding(process.env);
if (!config) {
  console.error('未配置 SIDENOTE_EMBEDDING_API_KEY，跨视频知识库处于关闭状态。');
  process.exit(1);
}

console.log(`端点  ${config.baseUrl}`);
console.log(`模型  ${config.model}`);
console.log(`维度  ${config.dimensions}（配置值）\n`);

const embedder = createEmbedder(config);
const passages = await embedder.embed(PASSAGES.map((text) => text.replace(/\s+/g, ' ').trim()));
console.log(`✓ 调用成功，返回 ${passages[0]!.length} 维`);

let failures = 0;
for (const probe of PROBES) {
  const [query] = await embedder.embed([probe.query]);
  const scores = passages.map((passage) => cosineSimilarity(query!, passage));
  const best = scores.indexOf(Math.max(...scores));
  const margin = scores[probe.expect]! - Math.max(...scores.filter((_, i) => i !== probe.expect));
  if (best !== probe.expect) failures += 1;
  console.log(
    `${best === probe.expect ? '✓' : '✗'} 「${probe.query}」` +
      ` 命中第 ${best + 1} 段，得分 ${scores[probe.expect]!.toFixed(3)}，领先 ${margin.toFixed(3)}`,
  );
}

const [noise] = await embedder.embed([UNRELATED]);
const floor = Math.max(...passages.map((passage) => cosineSimilarity(noise!, passage)));
console.log(`\n无关问题的最高分：${floor.toFixed(3)} —— 低于这个分数的结果肯定不相关。`);
console.log('注意这个下限并不低，所以代码里不设绝对阈值：它要按模型标定，换个模型就不一样。');

if (failures) {
  console.error(`\n✗ ${failures} 条语义检索没命中，换个模型或维度再试。`);
  process.exit(1);
}
console.log('\n✓ 维度与语义检索都正常，可以开索引。');
