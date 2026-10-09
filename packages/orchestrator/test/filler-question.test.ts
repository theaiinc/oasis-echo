import { describe, expect, it } from 'vitest';
import { isQuestion, pickContinuationFiller, pickFirstFiller } from '../src/filler.js';

describe('question-only fillers', () => {
  it('tells questions from statements, with or without a question mark', () => {
    for (const q of ['What does my schedule look like today?', 'what does my schedule look like today', 'So, can you check the board', 'is it done', 'Hôm nay anh có lịch gì', 'Cái này làm sao', 'Xong chưa']) expect(isQuestion(q), q).toBe(true);
    for (const s of ['Tell me.', 'Tell me more about the Arion One tickets', 'Hey.', 'Okay thanks', 'Anh muốn nghe thêm', '']) expect(isQuestion(s), s).toBe(false);
  });

  it('never says "Good question" when there was none', () => {
    for (let i = 0; i < 200; i++) {
      expect(pickFirstFiller(undefined, 'en', undefined, 'Tell me more.')).not.toMatch(/good question/i);
      expect(pickFirstFiller(undefined, 'vi', undefined, 'Kể thêm đi')).not.toMatch(/câu hỏi hay/i);
      expect(pickContinuationFiller('complex-reasoning', new Set(), undefined, 'en', undefined, 'Tell me more.')).not.toBe("That's a good one.");
    }
    const after = new Set(Array.from({ length: 300 }, () => pickFirstFiller(undefined, 'en', undefined, 'What is on my board?')));
    expect(after.has('Good question, one moment.')).toBe(true);
  });
});
