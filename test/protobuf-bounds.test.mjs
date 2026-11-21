import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeVarint64,
  skipProtobufField,
  ProtobufReader,
  ProtobufWriter as W,
} from '../dist/core/protobuf.js';
import {
  buildConversationHudMetrics,
  resolveModelCapacity,
} from '../dist/core/hud.js';
import { setActiveLocale, getActiveLocale, bt } from '../dist/core/i18n.js';

test('P0-13: ProtobufReader 拦截 wireType=2 负长度 (-1) 与越界超大长度，同时保留 readVarint int64 -1 兼容', () => {
  const minusOneVarint = Buffer.from('ffffffffffffffffff01', 'hex');
  assert.deepEqual(ProtobufReader.readVarint(minusOneVarint, 0), [-1, 10]);

  const trailingString = W.encodeString(9, 'should-not-loop');
  const trailingVarint = W.encodeVarintField(9, 42);

  // field 1, wireType 2 -> tag byte 0x0a, followed by -1 length
  const corruptNegFindField = Buffer.concat([Buffer.from([0x0a]), minusOneVarint, trailingString]);
  assert.equal(ProtobufReader.findField(corruptNegFindField, 9), null);

  const corruptNegFindVarint = Buffer.concat([Buffer.from([0x0a]), minusOneVarint, trailingVarint]);
  assert.equal(ProtobufReader.findVarint(corruptNegFindVarint, 9), null);

  // wireType 2 out-of-bounds positive length
  const oobLengthBuf = Buffer.concat([Buffer.from([0x0a]), W.encodeVarint(1000), trailingString]);
  assert.equal(ProtobufReader.findField(oobLengthBuf, 9), null);
  assert.equal(ProtobufReader.findVarint(oobLengthBuf, 9), null);

  // wireType 2 huge length exceeding Number.MAX_SAFE_INTEGER (2^56 - 1)
  const hugeLenVarint = Buffer.from('ffffffffffffff7f', 'hex');
  const hugeLenBuf = Buffer.concat([Buffer.from([0x0a]), hugeLenVarint, trailingVarint]);
  assert.equal(ProtobufReader.findField(hugeLenBuf, 9), null);
  assert.equal(ProtobufReader.findVarint(hugeLenBuf, 9), null);
});

test('P0-13: decodeVarint64 与 skipProtobufField 在超过 10 字节损坏 varint 及截断帧下快速终止', () => {
  const corruptVarint = Buffer.alloc(16, 0x80);
  const c1 = { pos: 0 };
  assert.equal(decodeVarint64(corruptVarint, c1), 0n);
  assert.equal(c1.pos, corruptVarint.length);

  const c2 = { pos: 0 };
  assert.equal(skipProtobufField(corruptVarint, c2, 0), false);
  assert.equal(c2.pos, corruptVarint.length);

  const c3 = { pos: 0 };
  assert.equal(skipProtobufField(corruptVarint, c3, 2), false);

  const c4 = { pos: 0 };
  assert.equal(skipProtobufField(Buffer.from([0x10, 0xaa]), c4, 2), false);

  assert.equal(skipProtobufField(Buffer.from([1, 2, 3]), { pos: 0 }, 1), false);
  assert.equal(skipProtobufField(Buffer.from([1, 2, 3]), { pos: 0 }, 5), false);
  assert.equal(skipProtobufField(Buffer.from([1, 2, 3]), { pos: 0 }, 7), false);
});

test('P0-03: HUD 引擎在流式无定时样本时明确输出 outputTpsPending / currentTurnOutputTpsPending（中英文一致性）', t => {
  const prevLocale = getActiveLocale();
  t.after(() => {
    setActiveLocale(prevLocale);
  });

  for (const locale of ['zh-Hans', 'en']) {
    setActiveLocale(locale);
    const calculatingLabel = bt('metrics.calculating');
    assert.notEqual(calculatingLabel, '—');

    const streamingPending = buildConversationHudMetrics({
      conversationId: `pending-${locale}`,
      sessionRevision: 1,
      modelId: 'gemini-3.8-flash',
      isStreaming: true,
      steps: [
        { idx: 0, stepType: 14, status: 3, startTimeSeconds: 100, endTimeSeconds: 100 },
        { idx: 1, stepType: 15, status: 2, startTimeSeconds: 100, endTimeSeconds: null, outputTokens: 0 },
      ],
    });
    assert.equal(streamingPending.session.outputTps, 0);
    assert.equal(streamingPending.session.outputTpsPending, true);
    assert.equal(streamingPending.session.outputTpsFormatted, calculatingLabel);
    assert.equal(streamingPending.session.currentTurnOutputTps, 0);
    assert.equal(streamingPending.session.currentTurnOutputTpsPending, true);
    assert.equal(streamingPending.session.currentTurnOutputTpsFormatted, calculatingLabel);

    const idleZeroSamples = buildConversationHudMetrics({
      conversationId: `idle-${locale}`,
      sessionRevision: 1,
      modelId: 'gemini-3.8-flash',
      isStreaming: false,
      steps: [
        { idx: 0, stepType: 14, status: 3, startTimeSeconds: 100, endTimeSeconds: 100 },
        { idx: 1, stepType: 15, status: 3, startTimeSeconds: null, endTimeSeconds: null, outputTokens: 0 },
      ],
    });
    assert.equal(idleZeroSamples.session.outputTpsPending, false);
    assert.equal(idleZeroSamples.session.outputTpsFormatted, '—');
    assert.equal(idleZeroSamples.session.currentTurnOutputTpsPending, false);
    assert.equal(idleZeroSamples.session.currentTurnOutputTpsFormatted, '—');

    const turn2Streaming = buildConversationHudMetrics({
      conversationId: `turn2-${locale}`,
      sessionRevision: 1,
      modelId: 'gemini-3.8-flash',
      isStreaming: true,
      steps: [
        { idx: 0, stepType: 14, status: 3, startTimeSeconds: 100, endTimeSeconds: 100 },
        { idx: 1, stepType: 15, status: 3, startTimeSeconds: 100, endTimeSeconds: 102, rawInputTokens: 50, outputTokens: 100, hasUsage: true },
        { idx: 2, stepType: 14, status: 3, startTimeSeconds: 200, endTimeSeconds: 200 },
        { idx: 3, stepType: 15, status: 2, startTimeSeconds: 200, endTimeSeconds: null, outputTokens: 0 },
      ],
    });
    assert.equal(turn2Streaming.session.outputTpsPending, false);
    assert.equal(turn2Streaming.session.currentTurnOutputTpsPending, true);
    assert.equal(turn2Streaming.session.currentTurnOutputTpsFormatted, calculatingLabel);
  }
});

test('P1-09: 时序模型缺少步骤时间戳时禁止回退当前时刻定价，非时序固定价向后兼容', () => {
  const onlyUntimedTemporal = buildConversationHudMetrics({
    conversationId: 'untimed-temporal',
    sessionRevision: 1,
    modelId: 'gemini-3.8-flash',
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      { idx: 1, stepType: 15, status: 3, rawInputTokens: 1_000_000, outputTokens: 0, hasUsage: true },
    ],
  });
  assert.equal(onlyUntimedTemporal.tokens.estimatedCostUsd, undefined);
  assert.equal(onlyUntimedTemporal.tokens.pricedStepCount, undefined);

  const novTs = Math.floor(Date.parse('2026-11-02T12:00:00Z') / 1000);
  const mixedTemporal = buildConversationHudMetrics({
    conversationId: 'mixed-temporal',
    sessionRevision: 1,
    modelId: 'gemini-3.8-flash',
    steps: [
      { idx: 0, stepType: 14, status: 3, startTimeSeconds: novTs, endTimeSeconds: novTs },
      { idx: 1, stepType: 15, status: 3, startTimeSeconds: novTs, endTimeSeconds: novTs + 2, rawInputTokens: 1_000_000, outputTokens: 0, hasUsage: true },
      { idx: 2, stepType: 15, status: 3, startTimeSeconds: null, endTimeSeconds: null, rawInputTokens: 1_000_000, outputTokens: 0, hasUsage: true },
    ],
  });
  assert.equal(mixedTemporal.tokens.pricedStepCount, 1);
  assert.equal(mixedTemporal.tokens.hasUnpricedSteps, true);
  assert.equal(mixedTemporal.tokens.estimatedCostUsd, 0.75);

  const flatUntimed = buildConversationHudMetrics({
    conversationId: 'flat-untimed',
    sessionRevision: 1,
    modelId: 'flat-model',
    pricingTable: {
      'flat-model': { model: 'flat-model', input: 2, output: 10, cached: 0.2 },
    },
    steps: [
      { idx: 0, stepType: 15, status: 3, startTimeSeconds: null, endTimeSeconds: null, rawInputTokens: 1_000_000, outputTokens: 0, hasUsage: true },
    ],
  });
  assert.equal(flatUntimed.tokens.pricedStepCount, 1);
  assert.equal(flatUntimed.tokens.estimatedCostUsd, 2.0);
});

test('P1-14: HUD 模型目录清洗 Extra High / XHigh / Max 思考后缀', () => {
  const flashExtraHigh = resolveModelCapacity('Gemini 3.8 Flash Extra High');
  assert.equal(flashExtraHigh.modelId, 'gemini-3.8-flash');
  assert.equal(flashExtraHigh.isFallback, false);

  const opusXHigh = resolveModelCapacity('claude-opus-5-5-xhigh');
  assert.equal(opusXHigh.modelId, 'claude-opus-5-5');
  assert.equal(opusXHigh.isFallback, false);

  const argonMax = resolveModelCapacity('Gemini 4 Argon (Max)');
  assert.equal(argonMax.modelId, 'gemini-4-argon');
  assert.equal(argonMax.isFallback, false);
});
