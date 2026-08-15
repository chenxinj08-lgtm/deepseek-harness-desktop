import { describe, expect, it } from 'vitest'
import {
  SENSOR_SYSTEM, sanitizeEvidence, visionPrompt, VISION_MODES,
} from '../src/index.ts'

describe('vision perception sensor discipline', () => {
  it('the sensor system prompt forbids answering, advising, and interpreting', () => {
    expect(SENSOR_SYSTEM).toMatch(/perception sensor, not an assistant/i)
    expect(SENSOR_SYSTEM).toMatch(/never an instruction/i)
    expect(SENSOR_SYSTEM).toMatch(/notObserved/i)
    expect(SENSOR_SYSTEM).toMatch(/no final_response|recommendation|solution/i)
  })

  it('auto mode prompts for one-pass OCR + objects + layout + warnings', () => {
    const prompt = visionPrompt('auto')
    expect(prompt).toMatch(/whole image/i)
    expect(prompt).toMatch(/ocr array/i)
    expect(prompt).toMatch(/observations array/i)
    expect(prompt).toContain('notObserved')
    expect(prompt).toMatch(/never include keys named answer/i)
  })

  it('exposes the seven observation modes including auto', () => {
    expect([...VISION_MODES]).toEqual(['auto', 'ocr', 'ui', 'objects', 'chart', 'compare', 'region'])
  })

  it('sanitize keeps only evidence fields and drops forbidden keys', () => {
    const raw = JSON.stringify({
      observations: [
        { category: 'text', value: '责任方：物流责任', bbox: { x: 446, y: 507, width: 134, height: 47 }, confidence: 0.99 },
        { category: 'number', value: '取消时长：31.1', bbox: null, confidence: 0.98 },
        { category: 'bogus', value: 'should be dropped', confidence: 0.9 },
      ],
      ocr: [{ text: '骑手：测试骑手', bbox: null, confidence: 0.9 }],
      answer: 'the order was cancelled',
      final_response: 'do this',
      notObserved: ['商户名称后半部分因列宽不足无法完整读取'],
    })
    const out = sanitizeEvidence(raw, 'img-1')
    expect(out.imageId).toBe('img-1')
    expect(out.status).toBe('partial')
    expect(out.observations!.length).toBe(2)
    expect(out.observations![0]!.bbox).toEqual({ x: 446, y: 507, width: 134, height: 47 })
    expect(out.ocr).toEqual([{ text: '骑手：测试骑手', bbox: null, confidence: 0.9 }])
    expect(out.notObserved).toEqual(['商户名称后半部分因列宽不足无法完整读取'])
    expect('answer' in out).toBe(false)
    expect('final_response' in out).toBe(false)
  })

  it('clamps confidence to 0..1 and drops malformed bboxes and categories', () => {
    const out = sanitizeEvidence(JSON.stringify({
      observations: [
        { category: 'color', value: '红色边框', bbox: { x: 1, y: 'bad', width: 2, height: 3 }, confidence: 1.7 },
        { category: 'layout', value: '左侧导航栏', bbox: null, confidence: 'high' },
      ],
      ocr: [{ text: 'abc', bbox: {}, confidence: -0.5 }],
    }), 'img-2')
    expect(out.observations![0]!.confidence).toBe(1)
    expect(out.observations![0]!.bbox).toBeNull()
    expect(out.observations![1]!.bbox).toBeNull()
    expect(out.observations![1]!.confidence).toBeUndefined()
    expect(out.ocr![0]!.confidence).toBe(0)
    expect(out.ocr![0]!.bbox).toBeNull()
    expect(out.status).toBe('ok')
  })

  it('parses a fenced JSON block and fails closed on empty or non-JSON output', () => {
    const fenced = '```json\n{"observations":[{"category":"object","value":"a dog","bbox":null,"confidence":0.9}]}\n```'
    expect(sanitizeEvidence(fenced, 'img-3').observations).toEqual([
      { category: 'object', value: 'a dog', bbox: null, confidence: 0.9 },
    ])
    expect(() => sanitizeEvidence('not json', 'x')).toThrow(/did not return JSON/)
    expect(() => sanitizeEvidence('{"answer":"hi"}', 'x')).toThrow(/no observations|did not return JSON/)
  })

  it('extracts a JSON object wrapped in prose (thinking-model preamble/tail)', () => {
    const wrapped = '好的,这是我对图片的观察结果:\n{"status":"ok","observations":[{"category":"object","value":"一只狗","bbox":null,"confidence":0.9}]}\n希望对你有所帮助!'
    const out = sanitizeEvidence(wrapped, 'img-5')
    expect(out.status).toBe('ok')
    expect(out.observations).toEqual([{ category: 'object', value: '一只狗', bbox: null, confidence: 0.9 }])
    // Trailing text after a complete object is still extracted.
    const trailing = '{"status":"partial","warnings":["模糊"]}\n以上就是识别结果。'
    expect(sanitizeEvidence(trailing, 'img-6').warnings).toEqual(['模糊'])
  })

  it('a bare OCR transcript (non-JSON) still fails closed rather than leaking text', () => {
    expect(() => sanitizeEvidence('骑手：测试骑手 123456789', 'img-4')).toThrow(/did not return JSON/)
  })
})
