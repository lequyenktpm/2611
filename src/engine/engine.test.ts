import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adjustCuesTiming,
  cuesToBlockTranscript,
  cuesToSrt,
  interpolateWordTimings,
  parseTranscriptAuto,
  shiftCuesAndWords,
  stripTimestampsFromScript,
} from './transcriptParser';
import { inferSpokenLanguageFromText } from '../server/mediaHelpers';
import { buildSceneGenerationPrompt } from './aiPromptBuilder';
import { choreographFromTranscript, resyncProjectTimingToCues } from './autoChoreographer';
import { computeElementFrameState, computeStaggerItemState } from './animationMath';
import {
  cleanDownloadFileName,
  cleanOutputTitleStem,
  resolveTabOutputSubfolder,
  TAB_OUTPUT_SUBFOLDERS,
} from './outputNaming';
import { generatePythonProjectFiles } from './pythonGenerator';
import {
  PRESET_3D_SHAPES_KARAOKE,
  PRESET_ED_PRONUNCIATION,
  PRESET_JP_EN_POLITE,
  PRESET_WATER_POLITE,
  PRESET_XUN52000_DARK,
  SAMPLE_JP_EN_SCENE_JSON,
  SAMPLE_JP_EN_TRANSCRIPT,
  SAMPLE_SCENE_PLAN,
  SAMPLE_WORDS_JSON,
  SAMPLE_XUN52000_SCENE_JSON,
  SAMPLE_XUN52000_TRANSCRIPT,
} from './demoPresets';
import {
  parseScenePlanJson,
  parseWordLevelJson,
  projectToWordsAndScenePlan,
  scenePlanToProject,
  summarizeScenePlan,
} from './scenePlanAdapter';
import { buildZipArchive } from '../utils/zipBuilder';
import { buildFfmpegArgs } from './ffmpegArgs';
import { resolveMp4EncodingParams } from './mp4Config';
import {
  applyCompositionToProject,
  applyCustomComponentComposition,
  getEligibleCompositionsForContext,
  LAYOUT_COMPOSITIONS,
  matchIllustrationForCue,
  pickCompositionFromContext,
  pickRandomComposition,
  recomposeProjectWithStyle,
  shouldApplyCompositionOverride,
} from './illustrationLayouts';
import {
  findVisualOverlaps,
  resolveProjectOverlaps,
  STAGE_SAFE_BOTTOM,
  estimateElementBounds,
} from './layoutSolver';
import {
  CANVAS_THEMES,
  CanvasThemeId,
  isDarkCanvasTheme,
  SceneElement,
} from './types';
import {
  ALL_ILLUSTRATION_VARIANTS,
  ALL_SCENE_ICONS,
  getEffectiveVectorCatalog,
  isKnownIllustrationVariant,
  pickContextualSceneIcon,
  resolveContextualVisualForCue,
} from './vectorComponentDb';
import {
  computeBackgroundImageDrawRect,
  getStageDimensionsForAspect,
  hitTestElementLayout,
  resolveElementLayoutForAspect,
  STAGE_HEIGHT,
  STAGE_WIDTH,
} from './canvasRenderer';
import {
  buildVectorComponentAiPrompt,
  deleteComponentVariant,
  parseVectorComponentAiJson,
  restoreBuiltInComponent,
  setCustomComponentDatabaseState,
  upsertCustomComponent,
} from './customComponentStore';
import {
  buildAiCreatorWebAiPrompt,
  buildEnglishReelsWebAiPrompt,
  buildReelCardsRuleBased,
  buildStarterLessonForLanguage,
  detectReelMode,
  getLevelsForLearningLanguage,
  getQuizCardSpeechParts,
  parseEnglishReelsAiJson,
  recommendCreatorItemCount,
  reelCardsToLessonProject,
  sanitizeTtsSpeech,
  splitMultipleExercisesFromText,
} from './englishReelsEngine';
import { pickVoiceForLangCode, splitMixedLanguageTtsSpans } from './bilingualTtsHelper';
import {
  compileVisualBuilderToPrimitives,
  createDefaultVisualBuilderConfig,
  VISUAL_LAYOUT_PRESETS,
} from './visualComponentBuilder';
import { alignKnownTextToPcmFloat, parseWavBufferToMonoFloat32 } from './forcedAligner';
import {
  buildReadingWebAiPrompt,
  cleanReadingWorksheetInput,
  parseReadingWebAiResponse,
} from './readingPromptBuilder';
import {
  computeReadingTimelineMetrics,
  paginateReadingWords,
  READING_BOOK_FRAMES,
  READING_POINTER_STYLES,
} from './eduStudioEffects';
import {
  computeDuckingGainAtTime,
  encodeStereoFloatChannelsToWavArrayBuffer,
  shiftReadingWordsForIntro,
} from './audioMixHelper';
import {
  buildSourceSegmentsFromCues,
  normalizeSceneIconWithAlias,
  resolveSyncAnchorTiming,
} from './storyboardV19';
import { validateStoryboardDocument } from './storyboardValidator';

test('interpolateWordTimings distributes word timestamps across cue duration', () => {
  const words = interpolateWordTimings('Give me water please', 1.0, 3.0);
  assert.equal(words.length, 4);
  assert.equal(words[0].start, 1.0);
  assert.equal(words[words.length - 1].end, 3.0);
  for (let i = 1; i < words.length; i++) {
    assert.ok(words[i].start >= words[i - 1].start);
    assert.ok(words[i].end >= words[i].start);
  }
});

test('parseTranscriptAuto parses SRT, Whisper JSON, and timestamped lines', () => {
  const srt = `1
00:00:00,500 --> 00:00:02,500
"Give me coffee." sounds rude!

2
00:00:02,600 --> 00:00:05,000
Try "Could I have a coffee?" instead.`;

  const srtCues = parseTranscriptAuto(srt);
  assert.equal(srtCues.length, 2);
  assert.equal(srtCues[0].start, 0.5);
  assert.equal(srtCues[1].end, 5.0);
  assert.ok(srtCues[0].words.length >= 4);

  const jsonCues = parseTranscriptAuto(
    JSON.stringify({
      segments: [
        { start: 0.1, end: 1.5, text: 'Hello world' },
        { start: 1.6, end: 3.2, text: 'Speak politely' },
      ],
    }),
  );
  assert.equal(jsonCues.length, 2);
  assert.equal(jsonCues[1].text, 'Speak politely');

  const roundTripSrt = cuesToSrt(jsonCues);
  assert.ok(roundTripSrt.includes('-->'));
});

test('choreographFromTranscript generates arranged elements with show/hide lifespans', () => {
  const cues = parseTranscriptAuto(`[0:00 - 0:02.5] "Give me water" is rude.
[0:02.6 - 0:05.2] Try "Could I have some water?" instead.`);
  const project = choreographFromTranscript(cues, { title: 'Polite Water' });

  assert.equal(project.title, 'Polite Water');
  assert.ok(project.duration >= 5.2);
  assert.ok(project.elements.some((e) => e.type === 'comparison-strip'));
  assert.ok(project.elements.some((e) => e.type === 'sentence-card'));
  assert.ok(project.elements.some((e) => e.type === 'karaoke-card'));
  assert.ok(project.elements.some((e) => e.type === 'tone-meter'));
});

test('computeElementFrameState handles appear/visible/disappear states accurately', () => {
  const el = PRESET_WATER_POLITE.elements.find((e) => e.id === 'el-card-rude')!;
  const before = computeElementFrameState(el, el.startTime - 0.1);
  assert.equal(before.visible, false);

  const entering = computeElementFrameState(el, el.startTime + 0.05);
  assert.equal(entering.visible, true);
  assert.ok(entering.opacity > 0 && entering.opacity < 1);

  const steady = computeElementFrameState(el, (el.startTime + el.endTime) / 2);
  assert.equal(steady.visible, true);
  assert.equal(steady.opacity, 1);

  const after = computeElementFrameState(el, el.endTime + 0.1);
  assert.equal(after.visible, false);
});

test('scenePlanAdapter parses words.json + scene.json and converts 3D shapes accurately', () => {
  const words = parseWordLevelJson(JSON.stringify(SAMPLE_WORDS_JSON));
  const plan = parseScenePlanJson(JSON.stringify(SAMPLE_SCENE_PLAN));
  assert.equal(words.length, 13);
  assert.ok(plan !== null && plan.scenes.length === 2);

  const converted = scenePlanToProject(words, plan!, { title: '3D Test' });
  const shapes = converted.elements.filter((e) => e.type === 'shape-3d');
  const karaokes = converted.elements.filter((e) => e.type === 'karaoke-card');
  assert.equal(shapes.length, 4);
  assert.ok(karaokes.length >= 2);
  assert.equal(shapes[0].startTime, words[0].start);

  const exported = projectToWordsAndScenePlan(PRESET_3D_SHAPES_KARAOKE);
  assert.equal(exported.wordsJson.words.length, 13);
  assert.ok(exported.scenePlan.scenes[0].shapes!.length >= 3);
});

test('generatePythonProjectFiles outputs complete modular video_maker package and valid ZIP', () => {
  const files = generatePythonProjectFiles(PRESET_3D_SHAPES_KARAOKE);
  const expectedFiles = [
    'main.py',
    'loader.py',
    'renderer_shapes.py',
    'renderer_text.py',
    'renderer_subtitles.py',
    'timeline.py',
    'video_builder.py',
    'sample_words.json',
    'sample_scene.json',
    'requirements.txt',
    'README.md',
  ] as const;

  for (const name of expectedFiles) {
    assert.ok(files[name].length > 20, `Expected non-empty file ${name}`);
  }

  assert.ok(files['renderer_shapes.py'].includes('GaussianBlur'));
  assert.ok(files['renderer_shapes.py'].includes('staircase_3d'));
  assert.ok(files['renderer_subtitles.py'].includes('#FACC15'));
  assert.ok(files['video_builder.py'].includes('VideoClip'));
  assert.ok(files['requirements.txt'].includes('moviepy'));

  const parsedWords = JSON.parse(files['sample_words.json']);
  const parsedScene = JSON.parse(files['sample_scene.json']);
  assert.ok(Array.isArray(parsedWords.words) && parsedWords.words.length > 0);
  assert.ok(Array.isArray(parsedScene.scenes) && parsedScene.scenes.length > 0);

  const zipBytes = buildZipArchive(files);
  assert.equal(zipBytes[0], 0x50);
  assert.equal(zipBytes[1], 0x4b);
  assert.equal(zipBytes[2], 0x03);
  assert.equal(zipBytes[3], 0x04);
});

test('parseTranscriptAuto parses standalone 00:00:00.000 JP-EN blocks and chunks CJK for karaoke', () => {
  const cues = parseTranscriptAuto(SAMPLE_JP_EN_TRANSCRIPT);
  assert.equal(cues.length, 27);
  assert.equal(cues[0].start, 0);
  assert.equal(cues[1].start, 11.96);
  assert.equal(cues[2].start, 17.04);
  assert.equal(cues[cues.length - 1].start, 99.8);
  assert.equal(cues[cues.length - 1].text, 'Follow along.');
  assert.deepEqual(
    cues[cues.length - 1].words.map((w) => w.word),
    ['Follow', 'along.'],
  );

  // Japanese cue 1 must be split into readable chunks rather than one giant token
  assert.ok(cues[0].words.length >= 12);
  for (const w of cues[0].words) {
    assert.ok(w.word.length <= 5, `Chunk too long: ${w.word}`);
  }

  const blockRoundTrip = cuesToBlockTranscript(cues.slice(0, 2));
  assert.ok(blockRoundTrip.includes('00:00:00.000'));
  assert.ok(blockRoundTrip.includes('00:00:11.960'));
});

test('buildSceneGenerationPrompt embeds formatted cues and flexible element schema', () => {
  const cues = parseTranscriptAuto(SAMPLE_JP_EN_TRANSCRIPT);
  const prompt = buildSceneGenerationPrompt(cues, {
    title: 'Can / Could / May',
    style: 'tiktok-cards',
  });

  assert.ok(prompt.includes('[Cue 1 | 00:00:00.000 ->'));
  assert.ok(prompt.includes('[Cue 27 | 00:01:39.800 ->'));
  assert.ok(prompt.includes('comparison_strip'));
  assert.ok(prompt.includes('staircase_3d'));
  assert.ok(prompt.includes('sentence_card'));
  assert.ok(prompt.includes('Can you pass the salt?'));
});

test('scenePlanToProject supports AI flexible elements[] with cuesOverride and Python export', () => {
  const cues = parseTranscriptAuto(SAMPLE_JP_EN_TRANSCRIPT);
  const words = cues.flatMap((c) => c.words);
  const parsed = parseScenePlanJson(JSON.stringify(SAMPLE_JP_EN_SCENE_JSON));
  assert.ok(parsed !== null);

  const project = scenePlanToProject(words, parsed!, {
    title: 'JP-EN Polite Lesson',
    cuesOverride: cues,
  });

  assert.equal(project.cues.length, 27);
  assert.ok(project.elements.some((e) => e.type === 'comparison-strip'));
  assert.ok(project.elements.some((e) => e.type === 'topic-pill'));
  assert.ok(project.elements.some((e) => e.type === 'illustration-prop'));
  assert.ok(project.elements.some((e) => e.type === 'sentence-card'));
  assert.ok(project.elements.some((e) => e.type === 'tone-meter'));
  assert.ok(
    project.elements.some(
      (e) => e.type === 'shape-3d' && e.props.kind === 'shape-3d' && e.props.shapeType === 'staircase_3d',
    ),
  );
  assert.equal(project.elements.filter((e) => e.type === 'karaoke-card').length, 27);

  const pyFiles = generatePythonProjectFiles(PRESET_JP_EN_POLITE);
  assert.ok(pyFiles['loader.py'].includes('from typing import Any, Dict, List, Tuple'));
  assert.ok(pyFiles['loader.py'].includes('_tokenize_for_karaoke'));
  assert.ok(pyFiles['renderer_text.py'].includes('NotoSansCJK'));
  assert.ok(pyFiles['timeline.py'].includes('_resolve_time_value'));
});

test('parseScenePlanJson extracts JSON from ChatGPT/Gemini markdown fences and converts word_stack/subtext', () => {
  const aiResponse = `Dưới đây là JSON dựng video tự động của bạn:

\`\`\`json
{
  "title": "AI Office Tip",
  "theme": "mint-breeze",
  "scenes": [
    {
      "id": "sc1",
      "elements": [
        { "type": "illustration", "variant": "office-work", "start": "00:00:00.000", "end": "00:00:04.000", "y": 620 },
        {
          "type": "sentence_card",
          "start": "00:00:00.500",
          "end": "00:00:03.800",
          "y": 970,
          "text": "Could I take Friday off?",
          "subtext": "Lịch sự với sếp",
          "badge": "question",
        },
        {
          "type": "word_stack",
          "start": "00:00:04.000",
          "end": "00:00:07.500",
          "y": 720,
          "rows": [
            { "prefix": "Can ", "suffix": "I...", "suffixColor": "#2563EB", "appearAt": "00:00:04.200", "phonetic": "Casual" }
          ]
        }
      ]
    }
  ]
}
\`\`\`

Chúc bạn render thành công!`;

  const parsed = parseScenePlanJson(aiResponse);
  assert.ok(parsed !== null);
  const cues = parseTranscriptAuto('00:00:00.000\nCould I take Friday off?\n\n00:00:04.000\nAsk politely.');
  const summary = summarizeScenePlan(parsed!, cues);
  assert.equal(summary.elementCount, 3);
  assert.equal(summary.cueCount, 2);

  const project = scenePlanToProject(
    cues.flatMap((c) => c.words),
    parsed!,
    { cuesOverride: cues },
  );
  assert.equal(project.theme, 'mint-breeze');
  const card = project.elements.find((e) => e.type === 'sentence-card');
  assert.ok(card && card.props.kind === 'sentence-card');
  assert.equal(card.props.subtext, 'Lịch sự với sếp');
  assert.equal(card.props.badge, 'question');
  assert.ok(project.elements.some((e) => e.type === 'word-stack'));
});

test('buildFfmpegArgs configures MJPEG -> H.264/AAC MP4 with audio or silent fallback', () => {
  const withAudio = buildFfmpegArgs({
    fps: 30,
    framesPath: '/tmp/job/frames.mjpeg',
    outputPath: '/tmp/job/output.mp4',
    audioPath: '/tmp/job/audio.mp3',
  });
  assert.ok(withAudio.includes('-f'));
  assert.ok(withAudio.includes('mjpeg'));
  assert.ok(withAudio.includes('/tmp/job/audio.mp3'));
  assert.ok(!withAudio.includes('anullsrc=channel_layout=stereo:sample_rate=44100'));
  assert.ok(withAudio.includes('libx264'));
  assert.ok(withAudio.includes('yuv420p'));
  assert.ok(withAudio.includes('aac'));
  assert.ok(withAudio.includes('+faststart'));
  assert.equal(withAudio[withAudio.length - 1], '/tmp/job/output.mp4');

  const silentClamped = buildFfmpegArgs({
    fps: 120,
    framesPath: '/tmp/job/frames.mjpeg',
    outputPath: '/tmp/job/silent.mp4',
    audioPath: null,
    crf: 10,
  });
  const fpsIdx = silentClamped.indexOf('-framerate');
  assert.equal(silentClamped[fpsIdx + 1], '60');
  const crfIdx = silentClamped.indexOf('-crf');
  assert.equal(silentClamped[crfIdx + 1], '16');
  assert.ok(silentClamped.includes('anullsrc=channel_layout=stereo:sample_rate=44100'));

  const highCrf = buildFfmpegArgs({
    fps: 24,
    framesPath: '/tmp/job/frames.mjpeg',
    outputPath: '/tmp/job/light.mp4',
    audioPath: null,
    crf: 99,
  });
  assert.equal(highCrf[highCrf.indexOf('-crf') + 1], '32');
});

test('resolveMp4EncodingParams resolves dimensions, bitrate scaling, and CRF for presets', () => {
  const fhdHigh30 = resolveMp4EncodingParams({
    resolution: '1080p',
    quality: 'high',
    fps: 30,
  });
  assert.equal(fhdHigh30.width, 1080);
  assert.equal(fhdHigh30.height, 1920);
  assert.equal(fhdHigh30.fps, 30);
  assert.equal(fhdHigh30.videoBitrate, 6_000_000);
  assert.equal(fhdHigh30.audioBitrate, 192_000);
  assert.equal(fhdHigh30.crf, 22);

  const hdUltra24 = resolveMp4EncodingParams({
    resolution: '720p',
    quality: 'ultra',
    fps: 24,
  });
  assert.equal(hdUltra24.width, 720);
  assert.equal(hdUltra24.height, 1280);
  assert.equal(hdUltra24.fps, 24);
  assert.equal(hdUltra24.crf, 18);
  assert.ok(hdUltra24.videoBitrate > 3_500_000 && hdUltra24.videoBitrate < 5_000_000);

  const qhdUltra60 = resolveMp4EncodingParams({
    resolution: '1440p',
    quality: 'ultra',
    fps: 60,
  });
  assert.equal(qhdUltra60.width, 1440);
  assert.equal(qhdUltra60.height, 2560);
  assert.equal(qhdUltra60.fps, 60);
  assert.ok(qhdUltra60.videoBitrate > 25_000_000);

  const sdStandard24 = resolveMp4EncodingParams({
    resolution: '540p',
    quality: 'standard',
    fps: 24,
  });
  assert.equal(sdStandard24.width, 540);
  assert.equal(sdStandard24.height, 960);
  assert.equal(sdStandard24.crf, 27);
  assert.ok(sdStandard24.videoBitrate >= 650_000);
});

test('resolveProjectOverlaps eliminates vertical collisions and protects karaoke zone', () => {
  const crowded: SceneElement[] = [
    {
      id: 'strip',
      type: 'comparison-strip',
      label: 'Strip',
      startTime: 0,
      endTime: 5,
      enterAnimation: 'drop-in',
      exitAnimation: 'fade-out',
      layout: { x: 540, y: 185, width: 900, scale: 1, zIndex: 10 },
      props: {
        kind: 'comparison-strip',
        items: [
          { label: 'At', accentColor: '#2563EB' },
          { label: 'On', accentColor: '#16A34A' },
          { label: 'In', accentColor: '#7C3AED' },
        ],
      },
    },
    {
      id: 'pill',
      type: 'topic-pill',
      label: 'Pill',
      startTime: 0,
      endTime: 5,
      enterAnimation: 'pop-up',
      exitAnimation: 'fade-out',
      layout: { x: 540, y: 260, width: 340, scale: 1, zIndex: 12 }, // Deliberately overlaps strip!
      props: { kind: 'topic-pill', text: 'Prepositions', bgColor: '#DDD6FE', textColor: '#4338CA' },
    },
    {
      id: 'stack',
      type: 'word-stack',
      label: '4-row stack',
      startTime: 0,
      endTime: 5,
      enterAnimation: 'pop-up',
      exitAnimation: 'fade-out',
      layout: { x: 540, y: 520, width: 760, scale: 1, zIndex: 16 }, // Tall 4-row stack!
      props: {
        kind: 'word-stack',
        rows: [
          { prefix: 'At ', suffix: 'point', suffixColor: '#2563EB', appearAt: 0 },
          { prefix: 'On ', suffix: 'surface', suffixColor: '#16A34A', appearAt: 0.2 },
          { prefix: 'In ', suffix: 'space', suffixColor: '#7C3AED', appearAt: 0.4 },
          { prefix: 'By ', suffix: 'time', suffixColor: '#EA580C', appearAt: 0.6 },
        ],
      },
    },
    {
      id: 'card',
      type: 'sentence-card',
      label: 'Long card',
      startTime: 0,
      endTime: 5,
      enterAnimation: 'pop-up',
      exitAnimation: 'shrink',
      layout: { x: 540, y: 780, width: 830, scale: 1, zIndex: 20 }, // Collides with tall stack!
      props: {
        kind: 'sentence-card',
        text: 'Could I take Friday off, please? Let me double check.',
        badge: 'check',
      },
    },
    {
      id: 'meter',
      type: 'tone-meter',
      label: 'Meter',
      startTime: 0,
      endTime: 5,
      enterAnimation: 'slide-up',
      exitAnimation: 'fade-out',
      layout: { x: 540, y: 920, width: 700, scale: 1, zIndex: 18 }, // Collides with card!
      props: {
        kind: 'tone-meter',
        title: 'TONE',
        leftLabel: 'casual',
        rightLabel: 'polite',
        valueStart: 0.2,
        valueEnd: 0.9,
        animateStart: 0.5,
        animateEnd: 4,
      },
    },
  ];

  const resolved = resolveProjectOverlaps(crowded);
  const violations = findVisualOverlaps(resolved);
  assert.deepEqual(violations, []);

  for (const el of resolved) {
    const b = estimateElementBounds(el);
    assert.ok(b.bottom <= STAGE_SAFE_BOTTOM + 10, `${el.id} exceeded safe bottom: ${b.bottom}`);
  }
});

test('matchIllustrationForCue matches contextually accurate vector scenes', () => {
  assert.equal(matchIllustrationForCue('In a cafe, thirsty for water'), 'cafe-water');
  assert.equal(matchIllustrationForCue('Give me a coffee latte please'), 'coffee-cup');
  assert.equal(matchIllustrationForCue('Boss walks by on Friday at the office'), 'office-work');
  assert.equal(matchIllustrationForCue('Heard at a hotel reception desk'), 'hotel-desk');
  assert.equal(matchIllustrationForCue('8:20 means twenty past eight on the clock'), 'clock-face');
  assert.equal(matchIllustrationForCue('Tone and smile sound warm and polite'), 'gauge-arc');
  assert.equal(matchIllustrationForCue('Ear check listening quiz'), 'ear-listen');
  assert.equal(matchIllustrationForCue('Here is a quick tip to remember'), 'lightbulb-tip');
});

test('all @englishpracticing168 compositions and presets produce 0 overlap violations', () => {
  const presets = [
    PRESET_JP_EN_POLITE,
    PRESET_WATER_POLITE,
    PRESET_ED_PRONUNCIATION,
    PRESET_3D_SHAPES_KARAOKE,
  ];
  for (const preset of presets) {
    const resolved = resolveProjectOverlaps(preset.elements);
    assert.deepEqual(findVisualOverlaps(resolved), [], `Preset ${preset.id} had overlaps`);
  }

  for (const comp of LAYOUT_COMPOSITIONS) {
    const recomposed = recomposeProjectWithStyle(PRESET_JP_EN_POLITE, comp.id);
    assert.equal(recomposed.compositionId, comp.id);
    assert.equal(recomposed.cues.length, PRESET_JP_EN_POLITE.cues.length);
    assert.ok(
      recomposed.elements.some(
        (e) => e.props.kind === 'illustration-prop' && e.props.variant === comp.signatureVariant,
      ) ||
        comp.id === 'story-scenes' ||
        (comp.id === 'word-reveal' && recomposed.elements.some((e) => e.type === 'sentence-card')) ||
        (comp.id === '3d-shapes' && recomposed.elements.some((e) => e.type === 'shape-3d')),
      `Expected signature variant for composition ${comp.id}`,
    );
    if (comp.id === 'dialogue-upgrade') {
      const firstDiag = recomposed.elements.find(
        (e) => e.props.kind === 'illustration-prop' && e.props.variant === 'dialogue-upgrade',
      );
      assert.ok(firstDiag && firstDiag.props.kind === 'illustration-prop');
      const prompts = (firstDiag.props.data?.upgrades || []).map((r) => r.prompt);
      assert.equal(new Set(prompts).size, prompts.length, 'Dialogue upgrade rows must not repeat prompts');
    }
    const violations = findVisualOverlaps(recomposed.elements);
    assert.deepEqual(violations, [], `Composition ${comp.id} produced overlaps`);
  }
});

test('pickRandomComposition rotates away from current composition and parses new AI diagram JSON', () => {
  for (const comp of LAYOUT_COMPOSITIONS) {
    const picked = pickRandomComposition(comp.id, comp.recommendedTheme, () => 0.42);
    assert.notEqual(picked.compositionId, comp.id);
  }

  const aiDiagramPlan = parseScenePlanJson(
    JSON.stringify({
      title: 'Time & Politeness',
      scenes: [
        {
          id: 'sc1',
          elements: [
            {
              type: 'clock_face',
              start: '00:00:00.000',
              end: '00:00:04.000',
              timeHour: 8,
              timeMinute: 20,
              formula: '8:20',
              subtitle: 'twenty past eight',
            },
            {
              type: 'gauge_arc',
              start: '00:00:00.000',
              end: '00:00:04.000',
              y: 635, // Deliberately placed at same Y as clock_face to verify collision solver!
              value: 0.85,
              subtitle: 'Polite',
            },
          ],
        },
      ],
    }),
  );
  assert.ok(aiDiagramPlan !== null);
  const cues = parseTranscriptAuto('00:00:00.000\nIt is twenty past eight.');
  const proj = scenePlanToProject(
    cues.flatMap((c) => c.words),
    aiDiagramPlan!,
    { cuesOverride: cues },
  );
  assert.equal(findVisualOverlaps(proj.elements).length, 0);
  assert.ok(
    proj.elements.some((e) => e.props.kind === 'illustration-prop' && e.props.variant === 'clock-face'),
  );
  assert.ok(
    proj.elements.some((e) => e.props.kind === 'illustration-prop' && e.props.variant === 'gauge-arc'),
  );
});

test('buildSceneGenerationPrompt supports @xun52000 Word Reveal Dark template and ai-decide composition', () => {
  const cues = parseTranscriptAuto(SAMPLE_XUN52000_TRANSCRIPT);

  // 1. Xun52000 Word Reveal style
  const xunPrompt = buildSceneGenerationPrompt(cues, {
    title: 'Stop Saying Very',
    style: 'word-reveal-dark',
  });
  assert.ok(xunPrompt.includes('WORD-REVEAL (@xun52000'));
  assert.ok(xunPrompt.includes('"theme": "studio-slate"'));
  assert.ok(xunPrompt.includes('sentence_card'));

  // 2. AI decides composition mode
  const aiDecidePrompt = buildSceneGenerationPrompt(cues, {
    title: 'Can / Could / May',
    style: 'tiktok-cards',
    compositionId: 'ai-decide',
  });
  assert.ok(aiDecidePrompt.includes('CHẾ ĐỘ AI TỰ CHỌN PHỐI TỐI ƯU'));
  assert.ok(aiDecidePrompt.includes('compositionId'));
  assert.ok(aiDecidePrompt.includes('compositionReason'));
  assert.ok(aiDecidePrompt.includes('phrase-icon-split'));
  assert.ok(aiDecidePrompt.includes('KHÔNG invent type'));

  // 3. Preset Xun52000 project validation
  assert.equal(PRESET_XUN52000_DARK.theme, 'studio-slate');
  assert.equal(findVisualOverlaps(PRESET_XUN52000_DARK.elements).length, 0);
  assert.ok(PRESET_XUN52000_DARK.elements.length > 0);
  assert.ok(PRESET_XUN52000_DARK.elements.some((e) => e.type === 'sentence-card'));
});

test('Look/See/Watch context picks phrase-icon-split and still applies after JSON exists', () => {
  const transcript = 'Look, see, and watch. I see TV every night is wrong. Watch the TV instead.';
  assert.equal(pickCompositionFromContext(transcript), 'phrase-icon-split');
  const recomposed = recomposeProjectWithStyle(PRESET_JP_EN_POLITE, 'phrase-icon-split');
  const illVariants = recomposed.elements
    .filter((e) => e.props.kind === 'illustration-prop')
    .map((e) => (e.props.kind === 'illustration-prop' ? e.props.variant : ''));
  assert.ok(illVariants.includes('phrase-icon-split'));
  assert.ok(illVariants.includes('contrast-pair-cards'));
  assert.ok(illVariants.includes('trio-icon-cards'));
  assert.ok(
    recomposed.elements.filter((e) => e.type !== 'karaoke-card').length >= 18,
    'phrase-icon-split must preserve full scene chrome and beats across the timeline',
  );
  const forced = applyCompositionToProject(PRESET_JP_EN_POLITE, 'phrase-icon-split');
  assert.equal(forced.compositionId, 'phrase-icon-split');
  assert.equal(findVisualOverlaps(recomposed.elements).length, 0);
});

test('vectorComponentDb resolves expanded @englishpracticing168 scenes, icons, and contrast/quiz cards', () => {
  assert.ok(ALL_SCENE_ICONS.length >= 42);
  assert.ok(ALL_SCENE_ICONS.includes('glasses'));
  assert.ok(ALL_ILLUSTRATION_VARIANTS.length >= 33);
  assert.ok(ALL_ILLUSTRATION_VARIANTS.includes('trio-icon-cards'));
  assert.ok(ALL_ILLUSTRATION_VARIANTS.includes('contrast-pair-cards'));
  assert.ok(ALL_ILLUSTRATION_VARIANTS.includes('quiz-fill-blank'));

  assert.equal(
    resolveContextualVisualForCue('Please show your boarding pass at airport gate B4').variant,
    'airport-travel',
  );
  assert.equal(
    resolveContextualVisualForCue('Waiter, could we see the dinner menu and the bill please?').variant,
    'restaurant-order',
  );
  assert.equal(
    resolveContextualVisualForCue('How much is the discount at this store?').variant,
    'shopping-price',
  );
  assert.equal(
    resolveContextualVisualForCue('I have a headache and need to see a doctor at the clinic').variant,
    'doctor-health',
  );
  assert.equal(
    resolveContextualVisualForCue('Today is sunny and warm according to the weather forecast').variant,
    'weather-forecast',
  );
  assert.equal(
    resolveContextualVisualForCue('Do not give up on phrasal verbs, figure out the meaning').variant,
    'phrasal-split',
  );
  assert.equal(
    resolveContextualVisualForCue('This English idiom is a piece of cake').variant,
    'idiom-split',
  );
  assert.equal(
    resolveContextualVisualForCue('Yesterday he went to Tokyo, tomorrow he will fly home').variant,
    'tense-timeline',
  );
  assert.equal(
    resolveContextualVisualForCue('Notice the syllable stress pattern on REcord vs reCORD').variant,
    'syllable-stress',
  );
  assert.equal(
    resolveContextualVisualForCue('Use rising intonation when asking yes/no questions').variant,
    'intonation-curve',
  );
  assert.equal(
    resolveContextualVisualForCue('Question: I cannot see without my glasses, fill in the blank')
      .variant,
    'quiz-fill-blank',
  );
  assert.equal(
    resolveContextualVisualForCue("You can't swap them! Look and Watch are not the same").variant,
    'contrast-pair-cards',
  );
  assert.equal(
    resolveContextualVisualForCue('Look, see, or watch? Learn the difference!').variant,
    'trio-icon-cards',
  );

  // Stop saying X -> Say Y generates dynamic-scene split-compare
  const stopSaying = resolveContextualVisualForCue('Stop saying very busy. Say swamped instead.');
  assert.equal(stopSaying.variant, 'dynamic-scene');
  assert.equal(stopSaying.data?.dynamicScene?.layout, 'split-compare');

  // Icon resolver
  assert.equal(pickContextualSceneIcon('Check in your luggage before the flight'), 'airplane');
  assert.equal(pickContextualSceneIcon('Bring an umbrella for heavy rain'), 'umbrella');
  assert.equal(pickContextualSceneIcon('I cannot see without my reading glasses'), 'glasses');
});

test('context-locked randomization forbids irrelevant clock-spotlight, unifies word-reveal & 3d-shapes, and supports clean themes', () => {
  const nonTimeTranscript = 'At the airport, show your boarding pass and luggage at the gate.';
  const eligible = getEligibleCompositionsForContext(nonTimeTranscript);
  assert.ok(!eligible.some((c) => c.id === 'clock-spotlight'));
  assert.ok(LAYOUT_COMPOSITIONS.some((c) => c.id === 'word-reveal'));
  assert.ok(LAYOUT_COMPOSITIONS.some((c) => c.id === '3d-shapes'));

  for (let i = 0; i < 25; i++) {
    const picked = pickRandomComposition(undefined, 'pastel-sunrise', () => (i * 0.13) % 1, {
      transcriptText: nonTimeTranscript,
      allowDarkThemes: true,
    });
    assert.notEqual(picked.compositionId, 'clock-spotlight');
    assert.ok(Object.values(CANVAS_THEMES).some((t) => t.id === picked.theme));
  }

  // Karaoke card adapts cleanly across all 5 clean themes (including studio-slate)
  for (const themeMeta of Object.values(CANVAS_THEMES)) {
    const recomposed = recomposeProjectWithStyle(PRESET_JP_EN_POLITE, 'story-scenes', {
      theme: themeMeta.id as CanvasThemeId,
    });
    assert.equal(recomposed.theme, themeMeta.id);
    const karaoke = recomposed.elements.find((e) => e.type === 'karaoke-card');
    assert.ok(karaoke && karaoke.props.kind === 'karaoke-card');
    assert.equal(
      karaoke.props.variant,
      isDarkCanvasTheme(themeMeta.id) ? 'dark-bar' : 'white-card',
    );
    assert.equal(findVisualOverlaps(recomposed.elements).length, 0);
  }

  // Unified word-reveal & 3d-shapes compositions render without overlaps
  for (const unifiedId of ['word-reveal', '3d-shapes'] as const) {
    const recomposed = recomposeProjectWithStyle(PRESET_WATER_POLITE, unifiedId);
    assert.equal(recomposed.compositionId, unifiedId);
    assert.equal(findVisualOverlaps(recomposed.elements).length, 0);
  }
});

test('autoChoreographer and scenePlanToProject support per-cue vector scenes and dynamic_scene with 0 overlaps', () => {
  const multiTopicCues = parseTranscriptAuto(`00:00:00.000
Show your passport at the airport gate.

00:00:03.500
Ask the waiter for the restaurant menu.

00:00:07.000
Stop saying very happy. Say thrilled instead.`);

  const project = choreographFromTranscript(multiTopicCues, {
    title: 'Multi Scene Test',
    theme: 'studio-slate',
  });
  const props = project.elements
    .filter((e) => e.props.kind === 'illustration-prop')
    .map((e) => (e.props.kind === 'illustration-prop' ? e.props.variant : ''));

  assert.ok(props.includes('airport-travel'));
  assert.ok(props.includes('restaurant-order'));
  assert.ok(props.includes('dynamic-scene') || props.includes('degree-scale'));
  assert.equal(findVisualOverlaps(project.elements).length, 0);

  const dynamicPlan = parseScenePlanJson(
    JSON.stringify({
      title: 'Airport Upgrade',
      theme: 'soft-lavender',
      scenes: [
        {
          id: 'sc1',
          elements: [
            {
              type: 'dynamic_scene',
              start: '00:00:00.000',
              end: '00:00:04.000',
              y: 635,
              dynamicScene: {
                layout: 'split-compare',
                badgeText: 'NATURAL ENGLISH',
                connector: 'arrow',
                motifs: [
                  { icon: 'airplane', label: 'I go airport', status: 'cross', accent: '#DC2626' },
                  { icon: 'luggage', label: 'Heading to Gate B4', status: 'check', accent: '#16A34A' },
                ],
              },
            },
          ],
        },
      ],
    }),
  );

  assert.ok(dynamicPlan !== null);
  const adapted = scenePlanToProject(
    multiTopicCues.flatMap((c) => c.words),
    dynamicPlan!,
    { cuesOverride: multiTopicCues },
  );
  assert.equal(adapted.theme, 'soft-lavender');
  assert.ok(
    adapted.elements.some(
      (e) =>
        e.props.kind === 'illustration-prop' &&
        e.props.variant === 'dynamic-scene' &&
        e.props.data?.dynamicScene?.layout === 'split-compare',
    ),
  );
  assert.equal(findVisualOverlaps(adapted.elements).length, 0);
});

test('computeBackgroundImageDrawRect centers and scales cover/contain cleanly for 1080x1920', () => {
  // Landscape 16:9 image (1920x1080) with cover fills full 1920 height and overflows width centered
  const landscapeCover = computeBackgroundImageDrawRect(1920, 1080, STAGE_WIDTH, STAGE_HEIGHT, 'cover');
  assert.equal(landscapeCover.dh, STAGE_HEIGHT);
  assert.ok(landscapeCover.dw > STAGE_WIDTH);
  assert.equal(landscapeCover.dy, 0);
  assert.ok(landscapeCover.dx < 0);

  // Landscape 16:9 image with contain fits full 1080 width centered vertically
  const landscapeContain = computeBackgroundImageDrawRect(1920, 1080, STAGE_WIDTH, STAGE_HEIGHT, 'contain');
  assert.equal(landscapeContain.dw, STAGE_WIDTH);
  assert.ok(landscapeContain.dh < STAGE_HEIGHT);
  assert.equal(landscapeContain.dx, 0);
  assert.ok(landscapeContain.dy > 0);
});

test('shouldApplyCompositionOverride preserves existing custom JSON unless forced', () => {
  assert.equal(shouldApplyCompositionOverride(true), false);
  assert.equal(shouldApplyCompositionOverride(true, false), false);
  assert.equal(shouldApplyCompositionOverride(true, true), true);
  assert.equal(shouldApplyCompositionOverride(false), true);
});

test('customComponentStore CRUD, AI Web prompt/JSON parser, and contextual vector matching', async () => {
  setCustomComponentDatabaseState({ components: [], deletedBuiltIns: [] }, { persistLocal: false });

  const prompt = buildVectorComponentAiPrompt('Bệnh viện thú y khám cho mèo', { category: 'life' });
  assert.ok(prompt.includes('Bệnh viện thú y khám cho mèo'));
  assert.ok(prompt.includes('"primitives"'));

  const aiResponse = `\`\`\`json
  {
    "variant": "custom-vet-clinic",
    "label": "Phòng khám thú y",
    "category": "life",
    "description": "Khám sức khỏe thú cưng",
    "keywords": ["vet", "pet clinic", "cat checkup", "puppy"],
    "defaultIcon": "stethoscope",
    "primitives": [
      { "shape": "rect", "x": -300, "y": -130, "w": 600, "h": 260, "radius": 28, "fill": "#FFFFFF", "shadow": true },
      { "shape": "icon", "icon": "stethoscope", "x": -120, "y": 10 },
      { "shape": "text", "x": 60, "y": 10, "text": "PET CHECKUP", "fill": "#2563EB", "fontSize": 24, "fontWeight": 800 }
    ]
  }
  \`\`\``;

  const parsed = parseVectorComponentAiJson(aiResponse);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].variant, 'custom-vet-clinic');

  await upsertCustomComponent(parsed[0]);
  assert.ok(isKnownIllustrationVariant('custom-vet-clinic'));
  assert.ok(getEffectiveVectorCatalog().some((c) => c.variant === 'custom-vet-clinic' && c.isCustom));

  // New video transcript automatically picks up the newly registered custom component!
  const matched = resolveContextualVisualForCue('Take your cat to the pet clinic for a vet checkup');
  assert.equal(matched.variant, 'custom-vet-clinic');

  // Hide and restore a built-in component
  await deleteComponentVariant('coffee-cup', true);
  assert.ok(!getEffectiveVectorCatalog().some((c) => c.variant === 'coffee-cup'));
  await restoreBuiltInComponent('coffee-cup');
  assert.ok(getEffectiveVectorCatalog().some((c) => c.variant === 'coffee-cup'));

  // Clean up test custom state
  setCustomComponentDatabaseState({ components: [], deletedBuiltIns: [] }, { persistLocal: false });
});

test('englishReelsEngine detects reading/quiz/vocab, splits multi-exercise text, parses AI JSON, and converts to LessonProject', () => {
  assert.equal(detectReelMode('Q1. Is Tokyo the capital of Japan?\nA. True\nB. False\nAnswer: True'), 'quiz');
  assert.equal(detectReelMode('commute /kəˈmjuːt/ - đi làm hằng ngày\nexhausted /ɪɡˈzɔːstɪd/ - kiệt sức'), 'vocab');
  assert.equal(detectReelMode('Morning routines shape how focused you feel all day long.'), 'reading');

  const multiText = `Exercise 1: Vocabulary
commute /kəˈmjuːt/ - đi làm hằng ngày
deadline /ˈded.laɪn/ - hạn chót công việc

Exercise 2: Comprehension Quiz
Q1. What helps reduce stress at work?
A. Planning ahead
B. Skipping lunch
Answer: A`;
  const split = splitMultipleExercisesFromText(multiText);
  assert.equal(split.length, 2);
  assert.equal(split[0].mode, 'vocab');
  assert.equal(split[1].mode, 'quiz');

  const ruleBased = buildReelCardsRuleBased(
    'commute /kəˈmjuːt/ - đi làm\nexhausted - kiệt sức',
    { title: 'Daily Work Vocab', mode: 'vocab', targetLang: 'Tiếng Việt' },
  );
  assert.equal(ruleBased.mode, 'vocab');
  assert.ok(ruleBased.cards.some((c) => c.type === 'vocab' && c.title === 'commute'));

  const prompt = buildEnglishReelsWebAiPrompt({
    sourceText: multiText,
    sourceUrl: 'https://example.com/english-lesson',
    mode: 'auto',
    targetLang: 'Tiếng Việt',
  });
  assert.ok(prompt.includes('ĐỊNH DẠNG JSON CỐ ĐỊNH'));
  assert.ok(prompt.includes('"cards"'));

  const aiParsed = parseEnglishReelsAiJson(
    JSON.stringify({
      title: 'Coffee Shop Phrases',
      mode: 'reading',
      cards: [
        {
          type: 'intro',
          badge: 'HOOK',
          title: 'Order Coffee Naturally',
          content: 'Stop saying Give me coffee!',
          translation: 'Đừng nói cộc lốc Give me coffee!',
          ttsText: 'Stop saying Give me coffee!',
        },
        {
          type: 'vocab',
          badge: 'NATURAL',
          title: 'Could I get an iced latte?',
          content: 'Could I get an iced latte, please?',
          phonetic: '/kʊd aɪ ɡet/',
          translation: 'Cho mình một ly latte đá nhé?',
          ttsText: 'Could I get an iced latte, please?',
        },
      ],
    }),
  );
  assert.ok(aiParsed !== null);
  assert.equal(aiParsed!.cards.length, 2);

  const project = reelCardsToLessonProject(aiParsed!.cards, {
    title: aiParsed!.title,
    theme: 'pastel-sunrise',
    compositionId: 'story-scenes',
  });
  assert.equal(project.cues.length, 2);
  assert.ok(project.elements.some((e) => e.type === 'karaoke-card'));
  assert.equal(findVisualOverlaps(project.elements).length, 0);
});

test('Bootstrap & Modern CSS component variants and Visual No-Code Builder compile cleanly', () => {
  assert.ok(ALL_ILLUSTRATION_VARIANTS.includes('bs-alert-tip'));
  assert.ok(ALL_ILLUSTRATION_VARIANTS.includes('bs-card-header'));
  assert.ok(ALL_ILLUSTRATION_VARIANTS.includes('bs-progress-meter'));
  assert.ok(ALL_ILLUSTRATION_VARIANTS.includes('css-bento-stats'));
  assert.ok(ALL_ILLUSTRATION_VARIANTS.includes('css-browser-mockup'));
  assert.ok(ALL_ILLUSTRATION_VARIANTS.includes('css-flashcard-flip'));
  assert.ok(ALL_ILLUSTRATION_VARIANTS.length >= 46);

  assert.equal(
    resolveContextualVisualForCue('Apply the grammar rule formula for passive voice').variant,
    'css-grammar-equation',
  );
  assert.equal(
    resolveContextualVisualForCue('Track your fluency progress goal this month').variant,
    'bs-progress-meter',
  );
  assert.equal(
    resolveContextualVisualForCue('Reading an online article in your web browser').variant,
    'css-browser-mockup',
  );

  for (const preset of VISUAL_LAYOUT_PRESETS) {
    const cfg = createDefaultVisualBuilderConfig({
      preset: preset.id,
      badgeText: 'PRO TIP',
      headline: 'Could you pass the salt?',
      subtext: 'Polite everyday request',
    });
    const primitives = compileVisualBuilderToPrimitives(cfg);
    assert.ok(primitives.length >= 4, `Preset ${preset.id} produced too few primitives`);
    assert.ok(
      primitives.some((p) => p.shape === 'text'),
      `Preset ${preset.id} missing text primitive`,
    );
  }
});

test('sanitizeTtsSpeech strips headings, quiz metadata, IPA, emojis, and markdown while keeping clean English speech', () => {
  const dirty = 'True/False Quiz\n1. **Commute** & travel /kəˈmjuːt/ 🎯 means going to work.\nAnswer: A';
  const cleaned = sanitizeTtsSpeech(dirty);
  assert.ok(!cleaned.includes('True/False'));
  assert.ok(!cleaned.includes('/kəˈmjuːt/'));
  assert.ok(!cleaned.includes('Answer:'));
  assert.ok(!cleaned.includes('🎯'));
  assert.ok(!cleaned.includes('**'));
  assert.ok(!cleaned.includes('&'));
  assert.ok(cleaned.includes('Commute and travel'));
  assert.ok(cleaned.includes('going to work'));
});

test('English Reels Studio builds interactive 4-part lesson, preserves customized UI components & 5s quiz countdown without overlaps', () => {
  const mixedLesson = `## Hotel Check-in & Polite Requests
When checking in, polite requests sound warmer.
1. Could we have a quiet room on a higher floor?

True / False Quiz
Q1. Saying Give me the key sounds friendlier than Could I have.
(A) True
(B) False
Answer: B
Explanation: Modal verbs like Could I soften requests politely.`;

  const built = buildReelCardsRuleBased(mixedLesson, {
    title: 'Hotel Check-in & Polite Requests',
    mode: 'auto',
    targetLang: 'Tiếng Việt',
  });

  assert.ok(built.cards.some((c) => c.type === 'intro' && c.visual?.variant === 'bs-card-header'));
  assert.ok(built.cards.some((c) => c.type === 'vocab'));
  const quizCard = built.cards.find((c) => c.type === 'quiz');
  assert.ok(quizCard);
  assert.equal(quizCard!.thinkSec, 5);
  assert.ok(quizCard!.ttsAnswerText?.includes('False'));
  assert.ok(built.cards.some((c) => c.type === 'outro' && c.visual?.variant === 'css-bento-stats'));

  const prompt = buildEnglishReelsWebAiPrompt({
    sourceText: mixedLesson,
    mode: 'auto',
    targetLang: 'Tiếng Việt',
  });
  assert.ok(prompt.includes('bs-card-header'));
  assert.ok(prompt.includes('css-flashcard-flip'));
  assert.ok(prompt.includes('"thinkSec": 5'));

  const project = reelCardsToLessonProject(built.cards, {
    title: built.title,
    theme: 'pastel-sunrise',
    compositionId: 'story-scenes',
  });

  // Ensure quiz 5s countdown pills, progress meter, quiz option comparison-strip, and custom UI components are preserved!
  assert.ok(
    project.elements.some(
      (e) => e.type === 'topic-pill' && e.props.kind === 'topic-pill' && e.props.text.includes('5 GIÂY'),
    ),
  );
  assert.ok(
    project.elements.some(
      (e) =>
        e.type === 'illustration-prop' &&
        e.props.kind === 'illustration-prop' &&
        e.props.variant === 'bs-progress-meter',
    ),
  );
  assert.ok(
    project.elements.some(
      (e) =>
        e.type === 'comparison-strip' &&
        e.id.startsWith('reel-quiz-opts-') &&
        e.props.kind === 'comparison-strip' &&
        e.props.items.length >= 2,
    ),
  );
  assert.ok(
    project.elements.some(
      (e) =>
        e.type === 'illustration-prop' &&
        e.props.kind === 'illustration-prop' &&
        e.props.variant === 'bs-card-header',
    ),
  );
  assert.equal(findVisualOverlaps(project.elements).length, 0);
});

test('supports 50+ @englishpracticing168 Bootstrap/CSS variants, inline customPrimitives in scenePlanToProject, and anti-repetition prompts', () => {
  assert.ok(ALL_ILLUSTRATION_VARIANTS.includes('css-sticky-note'));
  assert.ok(ALL_ILLUSTRATION_VARIANTS.includes('bs-badge-cluster'));
  assert.ok(ALL_ILLUSTRATION_VARIANTS.includes('css-magnifying-word'));
  assert.ok(ALL_ILLUSTRATION_VARIANTS.includes('bs-modal-quiz'));
  assert.ok(ALL_ILLUSTRATION_VARIANTS.length >= 50);

  assert.equal(
    resolveContextualVisualForCue('Golden rule sticky note reminder').variant,
    'css-sticky-note',
  );
  assert.equal(
    resolveContextualVisualForCue('Learn these collocation alternatives').variant,
    'bs-badge-cluster',
  );
  assert.equal(
    resolveContextualVisualForCue('Zoom in for a closer look at the nuance').variant,
    'css-magnifying-word',
  );
  assert.equal(
    resolveContextualVisualForCue('Time for a quick check pop quiz').variant,
    'bs-modal-quiz',
  );

  // Verify inline customPrimitives in KineticSub AI JSON passes cleanly through scenePlanToProject
  const cues = parseTranscriptAuto('00:00:00.000\nCheck this custom Bootstrap badge card.');
  const customPlan = parseScenePlanJson(
    JSON.stringify({
      title: 'Custom Inline UI',
      theme: 'pastel-sunrise',
      scenes: [
        {
          id: 'sc1',
          elements: [
            {
              type: 'illustration',
              variant: 'custom-ui',
              start: '00:00:00.000',
              end: '00:00:04.000',
              y: 635,
              customPrimitives: [
                { shape: 'rect', x: -320, y: -120, w: 640, h: 240, radius: 24, fill: '#FFFFFF', shadow: true },
                { shape: 'pill', x: -110, y: -95, w: 220, h: 40, fill: '#DBEAFE' },
                { shape: 'text', x: 0, y: 15, text: 'CUSTOM BOOTSTRAP UI', fill: '#1E3A8A', fontSize: 28, fontWeight: 800 },
              ],
            },
          ],
        },
      ],
    }),
  );
  assert.ok(customPlan !== null);
  const adapted = scenePlanToProject(
    cues.flatMap((c) => c.words),
    customPlan!,
    { cuesOverride: cues },
  );
  const illus = adapted.elements.find((e) => e.props.kind === 'illustration-prop');
  assert.ok(illus && illus.props.kind === 'illustration-prop');
  assert.ok(Array.isArray(illus.props.data?.customPrimitives));
  assert.equal(illus.props.data!.customPrimitives!.length, 3);
  assert.equal(findVisualOverlaps(adapted.elements).length, 0);

  // Verify both Web AI prompts teach Bootstrap/CSS recipes, customPrimitives, and anti-repetition rules
  const studioPrompt = buildSceneGenerationPrompt(cues, {
    title: 'Custom Prompt Test',
    style: 'tiktok-cards',
    compositionId: 'ai-decide',
  });
  assert.ok(studioPrompt.includes('customPrimitives'));
  assert.ok(studioPrompt.includes('BOOTSTRAP 5 / MODERN CSS'));
  assert.ok(studioPrompt.includes('LUẬT CHỐNG ĐỤNG HÀNG'));
  assert.ok(studioPrompt.includes('css-sticky-note'));

  const reelsPrompt = buildEnglishReelsWebAiPrompt({
    sourceText: 'Practice airport phrases politely.',
    mode: 'auto',
    targetLang: 'Tiếng Việt',
  });
  assert.ok(reelsPrompt.includes('customPrimitives'));
  assert.ok(reelsPrompt.includes('BOOTSTRAP 5 / MODERN CSS'));
  assert.ok(reelsPrompt.includes('LUẬT KHÔNG ĐỤNG HÀNG'));
  assert.ok(reelsPrompt.includes('bs-badge-cluster'));
});

test('stripTimestampsFromScript removes SRT, VTT, block-timestamps, inline ranges, and JSON timestamps for clean TTS speech', () => {
  const blockTranscript = `00:00:00.000
Stop saying very tired all the time.

00:00:03.200
Instead, try saying I am exhausted.`;
  assert.equal(
    stripTimestampsFromScript(blockTranscript),
    'Stop saying very tired all the time.\nInstead, try saying I am exhausted.',
  );

  const srtTranscript = `1
00:00:00,000 --> 00:00:02,500
At the airport, keep your boarding pass ready.

2
00:00:02,600 --> 00:00:05,100
Practice speaking one natural phrase every morning.`;
  assert.equal(
    stripTimestampsFromScript(srtTranscript),
    'At the airport, keep your boarding pass ready.\nPractice speaking one natural phrase every morning.',
  );

  const vttAndInline = `WEBVTT

[00:12 - 00:15] Could I have a quiet room?
[0:16] Yes, right this way.`;
  assert.equal(
    stripTimestampsFromScript(vttAndInline),
    'Could I have a quiet room?\nYes, right this way.',
  );

  const jsonTranscript = JSON.stringify({
    segments: [
      { start: 0, end: 2, text: 'First spoken line.' },
      { start: 2.2, end: 4, text: 'Second spoken line.' },
    ],
  });
  assert.equal(
    stripTimestampsFromScript(jsonTranscript),
    'First spoken line.\nSecond spoken line.',
  );

  // Plain sentences with numbers must NOT be mangled
  const plainScript = 'Line 1 has 500 dollars at 3 PM.\nSecond line stays intact.';
  assert.equal(stripTimestampsFromScript(plainScript), plainScript);
});

test('inferSpokenLanguageFromText detects Vietnamese, Japanese, Korean, Chinese, and English', () => {
  assert.equal(inferSpokenLanguageFromText('Xin chào các bạn học tiếng Anh mỗi ngày.'), 'Vietnamese');
  assert.equal(inferSpokenLanguageFromText('このシーンを想像してみて。'), 'Japanese');
  assert.equal(inferSpokenLanguageFromText('안녕하세요 오늘 영어 표현을 배워봅시다.'), 'Korean');
  assert.equal(inferSpokenLanguageFromText('每天练习口语非常有用'), 'Chinese');
  assert.equal(inferSpokenLanguageFromText('Practice speaking one natural phrase every morning.'), 'English');
});

test('watermark & outro config is preserved in Studio 9:16 recompose and extends English Reels duration', () => {
  const wm = {
    watermarkEnabled: true,
    watermarkText: '@MyEnglishStudio',
    watermarkCorner: 'top-right' as const,
    watermarkOpacity: 0.7,
    outroSeconds: 3,
    outroLine1: 'Thanks for watching!',
    outroLine2: 'Follow for daily practice',
  };

  const withWm = { ...PRESET_JP_EN_POLITE, watermark: wm };
  const recomposed = recomposeProjectWithStyle(withWm, 'story-scenes');
  assert.deepEqual(recomposed.watermark, wm);

  const sampleCards = buildReelCardsRuleBased('Hello world.\nPractice daily.', {
    title: 'WM Reel',
    mode: 'reading',
    targetLang: 'Tiếng Việt',
  }).cards;

  const baseReel = reelCardsToLessonProject(sampleCards, {
    title: 'WM Reel',
    theme: 'pastel-sunrise',
    compositionId: 'story-scenes',
  });

  const wmReel = reelCardsToLessonProject(sampleCards, {
    title: 'WM Reel',
    theme: 'pastel-sunrise',
    compositionId: 'story-scenes',
    watermark: wm,
  });

  assert.deepEqual(wmReel.watermark, wm);
  assert.ok(Math.abs(wmReel.duration - (baseReel.duration + 3)) < 0.01);
});

test('resolveMp4EncodingParams returns even dimensions across 9:16, 16:9, 1:1, and 4:5', () => {
  const portrait = resolveMp4EncodingParams({
    aspectRatio: '9:16',
    resolution: '720p',
    quality: 'high',
    fps: 30,
  });
  assert.equal(portrait.width, 720);
  assert.equal(portrait.height, 1280);

  const landscape = resolveMp4EncodingParams({
    aspectRatio: '16:9',
    resolution: '1080p',
    quality: 'ultra',
    fps: 60,
  });
  assert.equal(landscape.width, 1920);
  assert.equal(landscape.height, 1080);
  assert.equal(landscape.fps, 60);

  const square = resolveMp4EncodingParams({
    aspectRatio: '1:1',
    resolution: '720p',
    quality: 'standard',
    fps: 24,
  });
  assert.equal(square.width, square.height);
  assert.equal(square.width % 2, 0);

  const social45 = resolveMp4EncodingParams({
    aspectRatio: '4:5',
    resolution: '720p',
    quality: 'high',
    fps: 30,
  });
  assert.equal(social45.width, 720);
  assert.equal(social45.height, 900);
});

function buildSyntheticPcmWav(sampleRate: number, durationSec: number): Buffer {
  const numSamples = Math.round(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  // Two clear speech bursts separated by silence (0.2s..1.4s and 1.8s..3.0s)
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const active = (t >= 0.2 && t <= 1.4) || (t >= 1.8 && t <= 3.0);
    const val = active ? Math.round(Math.sin(2 * Math.PI * 220 * t) * 14000) : 0;
    buf.writeInt16LE(val, 44 + i * 2);
  }
  return buf;
}

test('forcedAligner parses synthetic PCM 16-bit WAV and produces monotonic word timings inside audio duration', () => {
  const wavBuf = buildSyntheticPcmWav(16000, 3.4);
  const parsed = parseWavBufferToMonoFloat32(wavBuf);
  assert.equal(parsed.sampleRate, 16000);
  assert.equal(parsed.samples.length, Math.round(16000 * 3.4));

  const reference = 'Morning routines build focus.\nOne small step daily.';
  const aligned = alignKnownTextToPcmFloat(reference, parsed.samples, parsed.sampleRate);

  assert.equal(aligned.words.length, 8);
  assert.equal(aligned.segments.length, 2);
  assert.ok(aligned.islands.length >= 2);
  assert.ok(Math.abs(aligned.durationSec - 3.4) < 0.05);

  for (let i = 0; i < aligned.words.length; i++) {
    const w = aligned.words[i];
    assert.ok(w.end > w.start);
    assert.ok(w.end <= aligned.durationSec + 0.001);
    if (i > 0) {
      assert.ok(w.start >= aligned.words[i - 1].start);
    }
  }
});

test('readingPromptBuilder generates web-url & topic prompts and parses fenced JSON, raw JSON, and plain text', () => {
  const urlPrompt = buildReadingWebAiPrompt({
    mode: 'web-url',
    url: 'https://example.com/english-habits',
    sourceTitle: 'Daily Habits',
    sourceText: 'Start each day with ten calm minutes of English reading.',
    level: 'A2',
    wordCount: 95,
  });
  assert.ok(urlPrompt.includes('https://example.com/english-habits'));
  assert.ok(urlPrompt.includes('CEFR A2'));
  assert.ok(urlPrompt.includes('95 từ'));

  const topicPrompt = buildReadingWebAiPrompt({
    mode: 'topic',
    topic: 'Ordering coffee naturally',
    level: 'B1',
    wordCount: 120,
  });
  assert.ok(topicPrompt.includes('Ordering coffee naturally'));
  assert.ok(topicPrompt.includes('CEFR B1'));

  const fencedJson = parseReadingWebAiResponse(
    '```json\n{"title":"Morning Focus","topicBadge":"CEFR B1","level":"B1","text":"Line one.\\nLine two."}\n```',
    'B1',
  );
  assert.ok(fencedJson !== null);
  assert.equal(fencedJson!.title, 'Morning Focus');
  assert.equal(fencedJson!.text, 'Line one.\nLine two.');

  const rawJson = parseReadingWebAiResponse(
    'Here is your passage: {"title":"Calm Brew","text":"Drink water first. Enjoy your tea."}',
    'A2',
  );
  assert.ok(rawJson !== null);
  assert.equal(rawJson!.title, 'Calm Brew');

  const plain = parseReadingWebAiResponse(
    'Cafe Etiquette\nFirst, smile and greet the barista clearly.\nNext, ask politely for your drink size.',
    'A2',
  );
  assert.ok(plain !== null);
  assert.equal(plain!.title, 'Cafe Etiquette');
  assert.ok(plain!.text.includes('barista clearly'));
});

test('eduStudioEffects provides 5 book frames, 7 pointer styles, non-overlapping outro metrics, and multi-page pagination', () => {
  assert.equal(READING_BOOK_FRAMES.length, 5);
  assert.equal(READING_POINTER_STYLES.length, 7);

  const words = [
    { word: 'Practice', start: 0.2, end: 1.1 },
    { word: 'every', start: 1.2, end: 2.3 },
    { word: 'day', start: 2.4, end: 8.6 },
  ];
  const metrics = computeReadingTimelineMetrics({
    words,
    contentDuration: 7.0,
    totalDuration: 10.0,
    outroSeconds: 3,
    outroText: 'Thanks for watching!\nFollow for more',
  });
  assert.equal(metrics.hasOutro, true);
  assert.equal(metrics.lastWordEnd, 8.6);
  assert.ok(metrics.outroStart >= metrics.lastWordEnd);
  assert.ok(metrics.effectiveTotalDuration >= metrics.outroStart + 3);

  const manyWords = Array.from({ length: 48 }, (_, i) => ({
    word: `word${i + 1}`,
    start: i * 0.4,
    end: (i + 1) * 0.4,
  }));
  const pages = paginateReadingWords(
    manyWords,
    (w) => w.length * 14,
    {
      startX: 40,
      maxW: 260,
      startY: 100,
      maxY: 220,
      lineHeight: 36,
      wordGap: 10,
    },
  );
  assert.ok(pages.length >= 2);
  assert.equal(pages.flat().length, manyWords.length);
});

test('illustrationLayouts produces distinct built-in presets and applies custom Kho Component compositions without overlaps', () => {
  const flowProj = recomposeProjectWithStyle(PRESET_JP_EN_POLITE, 'flow-steps');
  const gaugeProj = recomposeProjectWithStyle(PRESET_JP_EN_POLITE, 'gauge-tone');
  const checklistProj = recomposeProjectWithStyle(PRESET_JP_EN_POLITE, 'checklist-cards');

  const flowVariant = flowProj.elements.find((e) => e.props.kind === 'illustration-prop');
  const gaugeVariant = gaugeProj.elements.find((e) => e.props.kind === 'illustration-prop');
  const checklistVariant = checklistProj.elements.find((e) => e.props.kind === 'illustration-prop');

  assert.ok(flowVariant?.props.kind === 'illustration-prop');
  assert.ok(gaugeVariant?.props.kind === 'illustration-prop');
  assert.ok(checklistVariant?.props.kind === 'illustration-prop');
  assert.notEqual(flowVariant.props.variant, gaugeVariant.props.variant);
  assert.notEqual(gaugeVariant.props.variant, checklistVariant.props.variant);
  assert.notEqual(flowProj.theme, gaugeProj.theme);

  const customCfg = {
    variant: 'css-sticky-note' as const,
    sceneIcon: 'sparkles' as const,
    title: 'Pro Phrasing Tip',
    subtitle: 'Polite everyday English',
    speechText: 'Could I possibly grab an iced latte?',
    labels: ['Polite', 'Natural', 'Warm'],
    highlightWord: 'possibly',
    accentColor: '#4F46E5',
    showStrip: true,
    showSentenceCard: true,
    showToneMeter: false,
  };

  const allCustom = applyCustomComponentComposition(PRESET_JP_EN_POLITE, customCfg, {
    scope: 'all',
  });
  assert.equal(allCustom.compositionId, 'custom');
  const allIlls = allCustom.elements.filter((e) => e.props.kind === 'illustration-prop');
  assert.ok(allIlls.length >= 1);
  assert.ok(
    allIlls.every(
      (el) =>
        el.props.kind === 'illustration-prop' &&
        el.props.variant === 'css-sticky-note' &&
        el.props.data?.title === 'Pro Phrasing Tip',
    ),
  );
  assert.equal(findVisualOverlaps(allCustom.elements).length, 0);

  const activeCustom = applyCustomComponentComposition(
    flowProj,
    { ...customCfg, variant: 'bs-alert-tip', title: 'Single Cue Override' },
    { scope: 'active-cue', activeTimeSec: 1.5 },
  );
  assert.equal(activeCustom.compositionId, 'custom');
  assert.ok(
    activeCustom.elements.some(
      (e) => e.props.kind === 'illustration-prop' && e.props.variant === 'bs-alert-tip',
    ),
  );
  assert.equal(findVisualOverlaps(activeCustom.elements).length, 0);

  const customPrompt = buildSceneGenerationPrompt(PRESET_JP_EN_POLITE.cues, {
    title: 'Custom Composition Prompt',
    style: 'tiktok-cards',
    compositionId: 'custom',
    customConfig: customCfg,
  });
  assert.ok(customPrompt.includes('css-sticky-note'));
  assert.ok(customPrompt.includes('Pro Phrasing Tip'));
});

test('worksheet cleanup, English Reels Intro/Outro/Quiz context, and Reading Along Intro timeline have zero overlaps', () => {
  const sampleWorksheet = `## Practice Reading English Exercises for Beginner – Plans
English Reading Exercises for Beginner
## Exercise 1
Outside the COMFORT ZONE
In this exciting new TV programme, ten people go and live in the mountains for ten days.
Every day they do something difficult and sometimes dangerous.
They need to stay safe and comfortable (if possible!), but it’s not easy.
The two people who do the best win a prize of £25,000!
It’s Day 5 on Outside the comfort zone and everyone is thinking about the first thing they’re going to do after the programme finishes.
I’m going to eat a big meal of steak and chips.
I’m going to have a long hot bath.

True / False Quiz
1. Ten people live in the mountains for ten days.
(A) True
(B) False
Answer: (A) The passage says ten people go and live in the mountains for ten days.`;

  const cleaned = cleanReadingWorksheetInput(sampleWorksheet);
  assert.equal(cleaned.title, 'Outside the COMFORT ZONE');
  assert.ok(!cleaned.bodyText.includes('Practice Reading English Exercises'));
  assert.ok(!cleaned.bodyText.includes('Exercise 1'));
  assert.ok(cleaned.bodyText.includes('In this exciting new TV programme'));

  const reels = buildReelCardsRuleBased(sampleWorksheet);
  assert.equal(reels.title, 'Outside the COMFORT ZONE');
  assert.equal(reels.cards[0].type, 'intro');
  assert.ok(reels.cards[0].content.includes('Hôm nay học gì?'));
  assert.ok(reels.cards[reels.cards.length - 1].type === 'outro');

  for (const card of reels.cards) {
    assert.ok(!card.content.includes('Practice Reading English Exercises'));
    assert.ok(!card.content.includes('## Exercise 1'));
    assert.ok(!card.ttsText.includes('Practice Reading English Exercises'));
    assert.ok(!card.ttsText.includes('Exercise 1'));
    assert.equal(card.phonetic, undefined);
  }

  const vocabCards = reels.cards.filter((c) => c.type === 'vocab');
  assert.ok(vocabCards.length >= 3);
  assert.ok(vocabCards.some((c) => Boolean(c.translation || c.grammarNote)));

  const quizCards = reels.cards.filter((c) => c.type === 'quiz');
  assert.equal(quizCards.length, 1);
  assert.ok(quizCards[0].contextExcerpt && quizCards[0].contextExcerpt.includes('In this exciting new TV programme'));

  const quizSpeech = getQuizCardSpeechParts(quizCards[0], 1);
  assert.ok(quizSpeech.questionSpeech.toLowerCase().includes('question'));
  assert.ok(quizSpeech.thinkSec >= 5);
  assert.ok(quizSpeech.answerSpeech.toLowerCase().includes('correct answer'));

  const proj = reelCardsToLessonProject(reels.cards, { title: reels.title });
  assert.equal(findVisualOverlaps(proj.elements).length, 0);

  // Reading Along Intro shifting + Outro spacing
  const shifted = shiftReadingWordsForIntro(
    [
      { word: 'In', start: 0.1, end: 0.4 },
      { word: 'this', start: 0.5, end: 0.9 },
    ],
    3.4,
  );
  assert.equal(shifted[0].start, 3.5);
  assert.equal(shifted[1].end, 4.3);

  const metrics = computeReadingTimelineMetrics({
    words: shifted,
    contentDuration: 5.0,
    introEnabled: true,
    introSeconds: 3.4,
    outroSeconds: 3.5,
    outroText: 'Thanks for watching!\nSee you next time',
  });
  assert.equal(metrics.hasIntro, true);
  assert.equal(metrics.introEnd, 3.4);
  assert.ok(metrics.outroStart >= metrics.lastWordEnd);
  assert.ok(metrics.effectiveTotalDuration >= metrics.outroStart + 3.5);
});

test('audioMixHelper ducks BGM during speech, boosts during outro tail, and writes valid RIFF WAV headers', () => {
  const baseVol = 0.2;
  const duringSpeech = computeDuckingGainAtTime({
    timeSec: 2.0,
    speechWindows: [{ start: 1.0, end: 4.0 }],
    baseVolume: baseVol,
    outroStartSec: 8.0,
    totalDurationSec: 12.0,
  });
  const inOutroTail = computeDuckingGainAtTime({
    timeSec: 9.5,
    speechWindows: [{ start: 1.0, end: 4.0 }],
    baseVolume: baseVol,
    outroStartSec: 8.0,
    totalDurationSec: 12.0,
  });
  const fadeOutEdge = computeDuckingGainAtTime({
    timeSec: 11.9,
    speechWindows: [{ start: 1.0, end: 4.0 }],
    baseVolume: baseVol,
    outroStartSec: 8.0,
    totalDurationSec: 12.0,
  });

  assert.ok(duringSpeech < baseVol * 0.55);
  assert.ok(inOutroTail > duringSpeech * 2);
  assert.ok(fadeOutEdge < inOutroTail * 0.35);

  const left = new Float32Array([0, 0.25, -0.25, 0.5]);
  const right = new Float32Array([0, -0.25, 0.25, -0.5]);
  const wav = encodeStereoFloatChannelsToWavArrayBuffer(left, right, 48000);
  assert.equal(wav.byteLength, 44 + 4 * 4);
  const bytes = new Uint8Array(wav);
  assert.equal(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]), 'RIFF');
  assert.equal(String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]), 'WAVE');
});

test('English Reels supports targetLang localization, full untruncated quiz text, composition switching, backgroundImage, and mobile typography prompt rules', () => {
  const sampleLesson = `## New Year, New Me
Matt wants to make big changes in his life this year. He wrote down a list of resolutions to buy fewer clothes, save money, and travel worldwide.

True / False Quiz
Q1. Why did Matt write a list of plans?
(A) Because he forgot everything last year.
(B) He has a list of plans and intends to do them.
Answer: B
Explanation: Matt wrote resolutions and intends to follow through with every single plan.`;

  // 1. Japanese targetLang: zero Vietnamese stage chrome leaks & full option text preserved
  const jaReels = buildReelCardsRuleBased(sampleLesson, {
    title: 'New Year, New Me',
    mode: 'auto',
    targetLang: '日本語',
  });
  assert.ok(jaReels.cards[0].content.includes('今日のテーマ:'));
  const jaProject = reelCardsToLessonProject(jaReels.cards, {
    title: 'New Year, New Me',
    targetLang: '日本語',
    backgroundImage: {
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      fit: 'cover',
      scrimOpacity: 0.25,
      fileName: 'bg.png',
    },
  });
  assert.equal(jaProject.backgroundImage?.fileName, 'bg.png');
  assert.equal(findVisualOverlaps(jaProject.elements).length, 0);

  const jaTextAll = jaProject.elements
    .map((el) => {
      if (el.props.kind === 'topic-pill') return el.props.text;
      if (el.props.kind === 'comparison-strip') return el.props.items.map((i) => `${i.label} ${i.sublabel || ''}`).join(' ');
      if (el.props.kind === 'sentence-card') return `${el.props.text} ${el.props.subtext || ''}`;
      if (el.props.kind === 'illustration-prop') return `${el.props.data?.title || ''} ${el.props.data?.formula || ''} ${el.props.data?.highlightWord || ''}`;
      return '';
    })
    .join(' ');
  assert.ok(!jaTextAll.includes('Mở bài'));
  assert.ok(!jaTextAll.includes('ĐÁP ÁN ĐÚNG'));
  assert.ok(!jaTextAll.includes('ĐANG ĐỌC'));
  assert.ok(jaTextAll.includes('He has a list of plans and intends to do them.'));

  // 2. English targetLang check + prompt typography check
  const enPrompt = buildEnglishReelsWebAiPrompt({
    sourceText: sampleLesson,
    title: 'New Year, New Me',
    mode: 'auto',
    targetLang: 'English',
  });
  assert.ok(enPrompt.includes('TYPOGRAPHY & MOBILE READABILITY'));
  assert.ok(!enPrompt.includes('1. Mở bài'));

  const enReels = buildReelCardsRuleBased(sampleLesson, {
    title: 'New Year, New Me',
    mode: 'auto',
    targetLang: 'English',
  });
  const enProject = reelCardsToLessonProject(enReels.cards, {
    title: 'New Year, New Me',
    targetLang: 'English',
    compositionId: '3d-shapes',
  });
  assert.equal(enProject.compositionId, '3d-shapes');
  assert.ok(enProject.elements.some((el) => el.type === 'shape-3d'));
  assert.equal(findVisualOverlaps(enProject.elements).length, 0);

  // 3. Switching to word-reveal transforms layout visibly
  const wordRevealProj = reelCardsToLessonProject(enReels.cards, {
    title: 'New Year, New Me',
    targetLang: 'English',
    compositionId: 'word-reveal',
  });
  assert.equal(wordRevealProj.compositionId, 'word-reveal');
  assert.ok(!wordRevealProj.elements.some((el) => el.id.startsWith('reel-prop-')));
  assert.ok(wordRevealProj.elements.some((el) => el.id.startsWith('reel-card-') && el.type === 'sentence-card'));
  assert.equal(findVisualOverlaps(wordRevealProj.elements).length, 0);

  // 4. Custom composition AI prompt without manual labels does NOT leak Step 1/2/3
  const aiCustomPrompt = buildSceneGenerationPrompt(PRESET_JP_EN_POLITE.cues, {
    title: 'AI Autonomous Custom',
    style: 'tiktok-cards',
    compositionId: 'custom',
    customConfig: {
      variant: 'css-sticky-note',
      sceneIcon: 'sparkles',
      title: '',
      subtitle: '',
      speechText: '',
      labels: [],
      highlightWord: '',
      accentColor: '#4F46E5',
      showStrip: true,
      showToneMeter: false,
      showSentenceCard: true,
    },
  });
  assert.ok(aiCustomPrompt.includes('TYPOGRAPHY & MOBILE READABILITY'));
  assert.ok(!aiCustomPrompt.includes('nhãn gợi ý (`labels`):'));
  assert.ok(aiCustomPrompt.includes('BẮT BUỘC SÁT NGỮ CẢNH'));
  assert.ok(aiCustomPrompt.includes('AI LÀ NGƯỜI SÁNG TẠO CHÍNH'));
});

test('outputNaming cleans underscores, dates, timestamps, and routes tabs into subfolders inside output/', () => {
  assert.equal(
    cleanOutputTitleStem('2026-11-24_Hotel_Check-in_720p_ab12.mp4'),
    'Hotel Check-in',
  );
  assert.equal(
    cleanOutputTitleStem('Quiz_5s_Daily_Routine_1732440000000_reels_mp4'),
    'Quiz 5s Daily Routine',
  );
  assert.equal(
    cleanDownloadFileName('20261124_Can_Could_May_1080p', 'mp4'),
    'Can Could May.mp4',
  );
  assert.equal(
    cleanDownloadFileName('', 'srt', 'Fallback Title'),
    'Fallback Title.srt',
  );

  assert.equal(resolveTabOutputSubfolder('Studio 9:16'), TAB_OUTPUT_SUBFOLDERS.studio);
  assert.equal(resolveTabOutputSubfolder('English Reels'), TAB_OUTPUT_SUBFOLDERS.reels);
  assert.equal(resolveTabOutputSubfolder('Edu Merge'), TAB_OUTPUT_SUBFOLDERS.merge);
  assert.equal(resolveTabOutputSubfolder('Edu Karaoke'), TAB_OUTPUT_SUBFOLDERS.karaoke);
  assert.equal(resolveTabOutputSubfolder('Reading Along'), TAB_OUTPUT_SUBFOLDERS.reading);
  assert.equal(resolveTabOutputSubfolder('Batch'), TAB_OUTPUT_SUBFOLDERS.batch);
  assert.equal(
    resolveTabOutputSubfolder('English Reels', 'output/output/Custom Folder'),
    'output/Custom Folder',
  );
});

test('shiftCuesAndWords, adjustCuesTiming, and resyncProjectTimingToCues adjust timing while preserving backgroundImage', () => {
  const baseCues = PRESET_JP_EN_POLITE.cues.slice(0, 2).map((cue) => ({
    ...cue,
    words: (cue.words || []).map((w) => ({ ...w })),
  }));

  const shifted = shiftCuesAndWords(baseCues, 200);
  assert.ok(Math.abs(shifted[0].start - (baseCues[0].start + 0.2)) < 0.001);
  assert.ok(Math.abs(shifted[0].end - (baseCues[0].end + 0.2)) < 0.001);
  if (shifted[0].words && baseCues[0].words) {
    assert.ok(Math.abs(shifted[0].words[0].start - (baseCues[0].words[0].start + 0.2)) < 0.001);
  }

  const clampedNegative = shiftCuesAndWords(baseCues, -10000);
  assert.equal(clampedNegative[0].start, 0);
  assert.ok(clampedNegative[0].end > clampedNegative[0].start);

  const fitted = adjustCuesTiming(baseCues, { targetDurationSec: 10 });
  assert.ok(Math.abs(fitted[fitted.length - 1].end - 10) < 0.02);
  for (const cue of fitted) {
    assert.ok(cue.end > cue.start);
    if (cue.words) {
      for (let i = 0; i < cue.words.length; i += 1) {
        assert.ok(cue.words[i].end >= cue.words[i].start);
        if (i > 0) {
          assert.ok(cue.words[i].start >= cue.words[i - 1].start);
        }
      }
    }
  }

  const projectWithBg = {
    ...PRESET_JP_EN_POLITE,
    backgroundImage: {
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      fit: 'cover' as const,
      scrimOpacity: 0.25,
      fileName: 'preserved.png',
    },
  };
  const updatedCues = adjustCuesTiming(PRESET_JP_EN_POLITE.cues, { speedFactor: 1.25 });
  const resynced = resyncProjectTimingToCues(projectWithBg, updatedCues, { resyncVisuals: true });
  assert.equal(resynced.backgroundImage?.fileName, 'preserved.png');
  const lastCueEnd = updatedCues[updatedCues.length - 1].end;
  assert.ok(resynced.duration >= lastCueEnd);
  assert.ok(Math.abs(resynced.duration - (lastCueEnd + 0.35)) < 0.8);
  const karaokeEl = resynced.elements.find((el) => el.type === 'karaoke-card');
  assert.ok(karaokeEl && karaokeEl.props.kind === 'karaoke-card');
  if (karaokeEl && karaokeEl.props.kind === 'karaoke-card') {
    assert.ok(Math.abs(karaokeEl.startTime - updatedCues[0].start) < 0.01);
    assert.ok(Math.abs(karaokeEl.endTime - updatedCues[0].end) < 0.01);
    assert.equal(karaokeEl.props.words?.length ?? 0, updatedCues[0].words?.length ?? 0);
  }
});

test('computeStaggerItemState reveals staggered children smoothly without negative progress', () => {
  const before = computeStaggerItemState(0.05, 2, 0.08, 0.36);
  assert.equal(before.opacity, 0);
  assert.ok(before.translateY > 0);
  assert.ok(before.scale < 1);

  const mid = computeStaggerItemState(0.30, 1, 0.08, 0.36);
  assert.ok(mid.opacity > 0 && mid.opacity < 1);
  assert.ok(mid.progress > 0 && mid.progress < 1);

  const done = computeStaggerItemState(1.2, 2, 0.08, 0.36);
  assert.equal(done.opacity, 1);
  assert.equal(done.translateY, 0);
  assert.equal(done.scale, 1);
});

test('Storyboard v1.9 prompt preserves verbatim source_segments, audioDurationSec gap, and 5-stage schema rules', () => {
  const cues = [
    { id: 'c1', start: 0.0, end: 3.4, text: '"I\'m looking," he says,', words: [] },
    { id: 'c2', start: 3.5, end: 7.2, text: 'because the bright light was glowing.', words: [] },
    { id: 'c3', start: 134.0, end: 138.264, text: 'And that is why careful observation matters.', words: [] },
  ];

  const prompt = buildSceneGenerationPrompt(cues, {
    title: 'Observation Story',
    style: 'tiktok-cards',
    compositionId: 'ai-decide',
    audioDurationSec: 140.9,
  });

  assert.ok(prompt.includes('"schema_version": "1.9"'));
  assert.ok(prompt.includes('"source_segments"'));
  assert.ok(prompt.includes('\\"I\'m looking,\\" he says,'));
  assert.ok(prompt.includes('140.90s'));
  assert.ok(prompt.includes('138.26s'));
  assert.ok(prompt.includes('sync_anchor'));
  assert.ok(prompt.includes('tuyệt đối KHÔNG tự bịa tên'));

  const segments = buildSourceSegmentsFromCues(cues);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].segment_id, 'seg_001');
  assert.equal(segments[0].text, '"I\'m looking," he says,');
});

test('validateStoryboardDocument catches semantic errors and approves clean multi-scene v1.9 JSON', () => {
  const cues = [
    { id: 'c1', start: 0.0, end: 4.0, text: '"I\'m looking," he says, under the bright lamp.', words: [] },
    { id: 'c2', start: 4.2, end: 8.5, text: 'First compare option A with option B carefully.', words: [] },
    { id: 'c3', start: 8.7, end: 12.8, text: 'Finally, confirm the step on the right.', words: [] },
  ];

  const validDoc = {
    schema_version: '1.9',
    title: 'Multi-Scene Lesson',
    theme: 'studio-slate',
    compositionId: 'story-scenes',
    compositionReason: 'Narrative story with comparison',
    style_profile: {
      palette: 'studio-slate',
      primaryAccent: '#4F46E5',
    },
    source_segments: buildSourceSegmentsFromCues(cues),
    scenes: [
      {
        scene_id: 'sc_01',
        title: 'Scene 1',
        learning_objective: 'Introduce dialogue context',
        elements: [
          {
            element_id: 'el_01',
            kind: 'text',
            role: 'quote_card',
            content: '"I\'m looking," he says, under the bright lamp.',
            sync_anchor: {
              segment_id: 'seg_001',
              anchor_type: 'full_segment',
              quote: '"I\'m looking," he says,',
            },
            position: { x: 0.08, y: 0.14, width: 0.84, height: 0.14 },
          },
          {
            element_id: 'el_02',
            kind: 'illustration',
            role: 'visual',
            variant: 'css-sticky-note',
            sceneIcon: 'lightning',
            sync_anchor: {
              segment_id: 'seg_001',
              anchor_type: 'phrase',
              quote: 'under the bright lamp',
            },
            position: { x: 0.12, y: 0.34, width: 0.76, height: 0.24 },
          },
        ],
      },
      {
        scene_id: 'sc_02',
        title: 'Scene 2',
        learning_objective: 'Compare options visually',
        elements: [
          {
            element_id: 'el_03',
            kind: 'object',
            role: 'subject',
            object_spec: { label: 'Option A', icon: 'book' },
            sync_anchor: {
              segment_id: 'seg_002',
              anchor_type: 'segment_start',
              quote: 'First compare option A',
            },
            position: { x: 0.08, y: 0.22, width: 0.36, height: 0.22 },
          },
          {
            element_id: 'el_04',
            kind: 'connector',
            role: 'relation',
            connector_spec: { from: 'el_03', to: 'el_05', direction: 'right', label: 'vs', arrow: true },
            sync_anchor: {
              segment_id: 'seg_002',
              anchor_type: 'phrase',
              quote: 'with option B',
            },
            position: { x: 0.45, y: 0.28, width: 0.1, height: 0.1 },
          },
          {
            element_id: 'el_05',
            kind: 'object',
            role: 'target',
            object_spec: { label: 'Option B', icon: 'scale' },
            sync_anchor: {
              segment_id: 'seg_003',
              anchor_type: 'full_segment',
              quote: 'confirm the step',
            },
            position: { x: 0.56, y: 0.22, width: 0.36, height: 0.22 },
          },
        ],
      },
    ],
  };

  const cleanReport = validateStoryboardDocument(validDoc, cues, { audioDurationSec: 13.0 });
  assert.deepEqual(cleanReport.errors, []);
  assert.deepEqual(cleanReport.warnings, []);
  assert.equal(cleanReport.valid, true);
  assert.equal(cleanReport.schemaVersion, '1.9');

  // Now construct a broken doc with every semantic bug
  const brokenDoc = {
    schema_version: '1.9',
    source_segments: [
      { segment_id: 'seg_001', start: 0, end: 4, text: 'I\'m looking he says' }, // drifted punctuation
      { segment_id: 'seg_001', start: 4.2, end: 8.5, text: 'Duplicate segment ID' }, // duplicate ID
    ],
    scenes: [
      {
        scene_id: 'sc_01',
        elements: [
          {
            element_id: 'el_dup',
            kind: 'text',
            content: 'Bad quote and karaoke zone breach',
            sync_anchor: {
              segment_id: 'seg_001',
              anchor_type: 'phrase',
              quote: 'completely fabricated quote',
            },
            position: { x: 0.08, y: 0.72, width: 0.84, height: 0.16 }, // 0.88 > 0.76 karaoke zone
          },
          {
            element_id: 'el_dup', // duplicate element ID
            kind: 'illustration',
            sceneIcon: 'tree', // unsupported icon
            sync_anchor: {
              segment_id: 'seg_999', // missing segment
              anchor_type: 'segment_start',
            },
            position: { x: 0.10, y: 0.72, width: 0.70, height: 0.14 }, // overlaps el_dup
          },
        ],
      },
    ],
  };

  const brokenReport = validateStoryboardDocument(brokenDoc, cues, { audioDurationSec: 15.0 });
  assert.equal(brokenReport.valid, false);
  const errorCodes = new Set(brokenReport.errors.map((e) => e.code));
  const warningCodes = new Set(brokenReport.warnings.map((w) => w.code));
  assert.ok(errorCodes.has('DUPLICATE_SEGMENT_ID'));
  assert.ok(errorCodes.has('DUPLICATE_ELEMENT_ID'));
  assert.ok(errorCodes.has('MISSING_SYNC_SEGMENT'));
  assert.ok(errorCodes.has('SYNC_ANCHOR_QUOTE_MISMATCH'));
  assert.ok(errorCodes.has('INVALID_SCENE_ICON'));
  assert.ok(errorCodes.has('KARAOKE_ZONE_VIOLATION'));
  assert.ok(errorCodes.has('ELEMENT_SPATIAL_OVERLAP'));
  assert.ok(warningCodes.has('TRANSCRIPT_NOT_VERBATIM'));
  assert.ok(warningCodes.has('AUDIO_TAIL_GAP'));
});

test('scenePlanToProject converts multi-scene v1.9 JSON with sync_anchor phrase timing, normalized top-left geometry, object/connector, and Python support', () => {
  const cues = [
    {
      id: 'c1',
      start: 0.0,
      end: 4.0,
      text: '"I\'m looking," he says, under the lamp.',
      words: [
        { word: '"I\'m', start: 0.0, end: 0.5 },
        { word: 'looking,"', start: 0.55, end: 1.1 },
        { word: 'he', start: 1.15, end: 1.4 },
        { word: 'says,', start: 1.45, end: 1.9 },
        { word: 'under', start: 2.0, end: 2.4 },
        { word: 'the', start: 2.45, end: 2.7 },
        { word: 'lamp.', start: 2.75, end: 3.9 },
      ],
    },
    { id: 'c2', start: 4.2, end: 8.4, text: 'Compare option A with option B.', words: [] },
  ];

  // Test phrase-level word snapping
  const phraseResolved = resolveSyncAnchorTiming(
    { segment_id: 'seg_001', anchor_type: 'phrase', quote: 'under the lamp' },
    { segment_id: 'seg_001', start: 0.0, end: 4.0, text: cues[0].text },
    cues,
    0.0,
    4.0,
    1.5,
  );
  assert.ok(Math.abs(phraseResolved.startTime - 2.0) < 0.05);
  assert.ok(Math.abs(phraseResolved.endTime - 3.9) < 0.05);

  // Test invalid icon alias fallback
  const alias = normalizeSceneIconWithAlias('lightbulb');
  assert.equal(alias.icon, 'lightning');

  const v19Plan = {
    schema_version: '1.9',
    title: 'v1.9 Lesson',
    theme: 'studio-slate',
    compositionId: 'story-scenes',
    source_segments: buildSourceSegmentsFromCues(cues),
    scenes: [
      {
        scene_id: 'sc_01',
        title: 'Intro',
        elements: [
          {
            element_id: 'el_title',
            kind: 'pill',
            content: 'DIALOGUE',
            sync_anchor: { segment_id: 'seg_001', anchor_type: 'segment_start', quote: '"I\'m looking,"' },
            position: { x: 0.30, y: 0.06, width: 0.40, height: 0.05 },
          },
          {
            element_id: 'el_lamp',
            kind: 'illustration',
            sceneIcon: 'lightbulb',
            variant: 'css-sticky-note',
            title: 'Under the lamp',
            sync_anchor: { segment_id: 'seg_001', anchor_type: 'phrase', quote: 'under the lamp' },
            position: { x: 0.10, y: 0.20, width: 0.80, height: 0.28 },
          },
        ],
      },
      {
        scene_id: 'sc_02',
        title: 'Compare',
        elements: [
          {
            element_id: 'el_obj_a',
            kind: 'object',
            object_spec: { label: 'Option A', icon: 'book' },
            sync_anchor: { segment_id: 'seg_002', anchor_type: 'segment_start', quote: 'Option A' },
            position: { x: 0.08, y: 0.22, width: 0.36, height: 0.20 },
          },
          {
            element_id: 'el_conn',
            kind: 'connector',
            connector_spec: { from: 'el_obj_a', to: 'el_obj_b', direction: 'right', label: 'vs', arrow: true },
            sync_anchor: { segment_id: 'seg_002', anchor_type: 'full_segment' },
            position: { x: 0.45, y: 0.27, width: 0.10, height: 0.10 },
          },
          {
            element_id: 'el_obj_b',
            kind: 'object',
            object_spec: { label: 'Option B', icon: 'check' },
            sync_anchor: { segment_id: 'seg_002', anchor_type: 'phrase', quote: 'option B' },
            position: { x: 0.56, y: 0.22, width: 0.36, height: 0.20 },
          },
        ],
      },
    ],
  };

  const parsed = parseScenePlanJson(JSON.stringify(v19Plan));
  assert.ok(parsed);
  const summary = summarizeScenePlan(parsed!, cues);
  assert.equal(summary.schemaVersion, '1.9');
  assert.equal(summary.sceneCount, 2);
  assert.equal(summary.sourceSegmentCount, 2);
  assert.equal(summary.elementCount, 5);

  const project = scenePlanToProject([], parsed!, { title: 'v1.9 Test', cuesOverride: cues });
  assert.equal(findVisualOverlaps(project.elements).length, 0);

  const lampEl = project.elements.find((e) => e.id.includes('el_lamp'));
  assert.ok(lampEl && lampEl.props.kind === 'illustration-prop');
  assert.ok(Math.abs(lampEl!.startTime - 2.0) < 0.05);
  assert.equal(lampEl!.props.kind === 'illustration-prop' ? lampEl!.props.data?.sceneIcon : '', 'lightning');

  const connEl = project.elements.find((e) => e.id.includes('el_conn'));
  assert.ok(connEl && connEl.props.kind === 'illustration-prop');
  assert.ok((connEl!.props.kind === 'illustration-prop' ? connEl!.props.data?.customPrimitives?.length ?? 0 : 0) >= 2);

  // Center check for el_obj_a: x=0.08, width=0.36 => centerX = (0.08 + 0.18)*1080 = 280.8
  const objA = project.elements.find((e) => e.id.includes('el_obj_a'));
  assert.ok(objA && Math.abs(objA.layout.x - 280.8) < 40);

  // Python generator supports v1.9 scene_id / source_segments / sync_anchor
  const pyFiles = generatePythonProjectFiles(project);
  const timelinePy = pyFiles['timeline.py'] || '';
  const loaderPy = pyFiles['loader.py'] || '';
  assert.ok(timelinePy.includes('source_segments'));
  assert.ok(timelinePy.includes('sync_anchor'));
  assert.ok(loaderPy.includes("scene.get('scene_id'"));
});

test('Storyboard v1.9 preserves animation.duration_s transition without truncating component visibility, enriches bare-text scenes, and clamps canvas bounds', () => {
  const cues = [
    { id: 'c1', start: 0.0, end: 4.5, text: 'First compare polite requests at the airport gate.', words: [] },
    { id: 'c2', start: 4.7, end: 9.0, text: 'Always double check your boarding pass before boarding.', words: [] },
  ];

  // 1. animation.duration_s: 0.35 must NOT truncate pill/strip/illustration/object to 0.6s-1.2s
  const docWithAnimDur = {
    schema_version: '1.9',
    title: 'Transition Duration Regression',
    theme: 'pastel-sunrise',
    compositionId: 'story-scenes',
    source_segments: buildSourceSegmentsFromCues(cues),
    scenes: [
      {
        scene_id: 'sc_01',
        title: 'Scene 1',
        elements: [
          {
            element_id: 'el_strip',
            kind: 'strip',
            role: 'comparison_header',
            items: [{ label: 'Basic' }, { label: 'Natural' }],
            sync_anchor: { segment_id: 'seg_001', anchor_type: 'segment_start', quote: 'First compare' },
            position: { x: 0.08, y: 0.06, width: 0.84, height: 0.07 },
            animation: { in: 'drop-in', out: 'fade-out', duration_s: 0.35 },
          },
          {
            element_id: 'el_pill',
            kind: 'pill',
            role: 'scene_title',
            content: 'AIRPORT POLITE REQUESTS',
            sync_anchor: { segment_id: 'seg_001', anchor_type: 'segment_start', quote: 'First compare' },
            position: { x: 0.20, y: 0.145, width: 0.60, height: 0.05 },
            animation: { in: 'pop-up', out: 'fade-out', duration_s: 0.35 },
          },
          {
            element_id: 'el_ill',
            kind: 'illustration',
            variant: 'bs-card-header',
            title: 'Boarding Gate Check',
            sync_anchor: { segment_id: 'seg_001', anchor_type: 'phrase', quote: 'airport gate' },
            position: { x: 0.01, y: 0.22, width: 0.42, height: 0.20 },
            animation: { in: 'fade-scale', out: 'fade-out', duration_s: 0.35 },
          },
        ],
      },
      {
        // Text-only scene should be enriched with a contextual illustration-prop automatically
        scene_id: 'sc_02',
        title: 'Bare Text Scene',
        elements: [
          {
            element_id: 'el_txt_only',
            kind: 'text',
            role: 'example_sentence',
            content: 'Always double check your boarding pass before boarding.',
            sync_anchor: { segment_id: 'seg_002', anchor_type: 'full_segment', quote: 'boarding pass' },
            position: { x: 0.72, y: 0.48, width: 0.40, height: 0.16 },
          },
        ],
      },
    ],
  };

  const parsed = parseScenePlanJson(JSON.stringify(docWithAnimDur));
  assert.ok(parsed);
  const project = scenePlanToProject([], parsed!, { cuesOverride: cues });

  const stripEl = project.elements.find((e) => e.id === 'el_strip');
  const pillEl = project.elements.find((e) => e.id === 'el_pill');
  const illEl = project.elements.find((e) => e.id === 'el_ill');
  const txtEl = project.elements.find((e) => e.id === 'el_txt_only');
  const enrichedEl = project.elements.find((e) => e.id.startsWith('auto-enrich-prop-'));

  assert.ok(stripEl && stripEl.endTime - stripEl.startTime >= 4.0, 'strip should hold across scene');
  assert.ok(pillEl && pillEl.endTime - pillEl.startTime >= 2.2, 'pill should not flash for 0.6s');
  assert.ok(
    illEl && illEl.endTime >= 4.45 && illEl.endTime - illEl.startTime >= 1.0,
    'illustration should hold through end of segment without flashing',
  );
  assert.ok(enrichedEl && enrichedEl.props.kind === 'illustration-prop', 'bare-text cue should receive contextual illustration');

  // Horizontal bounds clamping check for edge-placed narrow boxes
  for (const el of [illEl!, txtEl!]) {
    const b = estimateElementBounds(el);
    assert.ok(b.left >= 20, `left bound ${b.left} should be >= 20`);
    assert.ok(b.right <= 1060, `right bound ${b.right} should be <= 1060`);
  }

  // word-reveal must stay minimal without injecting auto-enrich-prop-
  const wordRevealOnly = parseScenePlanJson(
    JSON.stringify({
      schema_version: '1.9',
      compositionId: 'word-reveal',
      source_segments: buildSourceSegmentsFromCues(cues.slice(0, 1)),
      scenes: [docWithAnimDur.scenes[1]],
    }),
  );
  const wordRevealProj = scenePlanToProject([], wordRevealOnly!, {
    cuesOverride: cues.slice(0, 1),
    compositionId: 'word-reveal',
  });
  assert.ok(!wordRevealProj.elements.some((e) => e.id.startsWith('auto-enrich-prop-')));

  // Wide Step-1 cuesOverride (e.g., 0..9.2s) must NOT suppress enrichment for bare-text seg_002 (4.7..9.0s)
  const wideCueProject = scenePlanToProject([], parsed!, {
    cuesOverride: [
      {
        id: 'wide-c1',
        start: 0.0,
        end: 9.2,
        text: 'First compare polite requests at the airport gate. Always double check your boarding pass before boarding.',
        words: [],
      },
    ],
  });
  const wideEnriched = wideCueProject.elements.find(
    (e) => e.id.startsWith('auto-enrich-prop-') && e.startTime <= 5.0 && e.endTime >= 8.5,
  );
  assert.ok(wideEnriched, 'wide Step-1 cuesOverride should not mask bare-text v1.9 segment 2');

  // Rich v1.9 prompt sample includes multi-scene components and transition clarification
  const richPrompt = buildSceneGenerationPrompt(cues, {
    title: 'Airport Check',
    compositionId: 'ai-decide',
  });
  assert.ok(richPrompt.includes('"kind": "strip"'));
  assert.ok(richPrompt.includes('"kind": "illustration"'));
  assert.ok(richPrompt.includes('"kind": "object"'));
  assert.ok(richPrompt.includes('"kind": "connector"'));
  assert.ok(richPrompt.includes('"kind": "meter"'));
  assert.ok(richPrompt.includes('CHỈ là tốc độ hiệu ứng bay vào/ra'));
});

test('buildAiCreatorWebAiPrompt supports autonomous blank discovery and custom topic hints without source-preservation rules', () => {
  const blankPrompt = buildAiCreatorWebAiPrompt({
    topicHint: '',
    targetLang: 'vi',
    itemCount: 8,
    formatPreference: 'auto',
  });

  assert.ok(blankPrompt.includes('AUTONOMOUS ENGLISH EDUCATIONAL CONTENT DIRECTOR'));
  assert.ok(blankPrompt.includes('5 practical video ideas'));
  assert.ok(blankPrompt.includes('A. Vocabulary Lists'));
  assert.ok(blankPrompt.includes('G. Real-life Conversations'));
  assert.ok(blankPrompt.includes('STRICT ANTI-REPETITION RULE'));
  assert.ok(blankPrompt.includes('"indexLabel"'));
  assert.ok(blankPrompt.includes('"word"'));
  assert.ok(blankPrompt.includes('"meaning"'));
  assert.ok(blankPrompt.includes('"example"'));
  assert.ok(blankPrompt.includes('"speech"'));
  assert.ok(blankPrompt.includes('01 / 08'));
  assert.ok(!blankPrompt.includes('Do NOT summarize'));
  assert.ok(!blankPrompt.includes('Preserve every learning content'));

  const customTopicPrompt = buildAiCreatorWebAiPrompt({
    topicHint: '8 words to sound smarter in daily conversations',
    audience: 'Vietnamese learners (B1-B2)',
    targetDuration: '45s',
    itemCount: 8,
    targetLang: 'vi',
    formatPreference: 'vocab',
  });
  assert.ok(customTopicPrompt.includes('8 words to sound smarter in daily conversations'));
  assert.ok(customTopicPrompt.includes('45s'));
});

test('parseEnglishReelsAiJson parses AI Creator Mode JSON cleanly with zero consecutive duplicate variants and zero visual overlaps', () => {
  const creatorJson = JSON.stringify({
    mode: 'vocab',
    title: '8 Words to Sound Smarter in Every Sentence',
    cards: [
      {
        type: 'title',
        kicker: 'LEVEL UP YOUR ENGLISH',
        title: '8 Words to Sound Smarter in Every Sentence',
        speech: 'Eight simple words to sound much smarter in English today.',
        translation: '8 từ vựng giúp bạn nói tiếng Anh tự nhiên và chuyên nghiệp hơn.',
        visual: {
          variant: 'css-kinetic-hook',
          title: '8 Smart Words',
          subtitle: 'Upgrade everyday sentences',
          sceneIcon: 'sparkles',
        },
      },
      {
        type: 'vocab',
        indexLabel: '01 / 08',
        word: 'Articulate',
        meaning: 'Expressing thoughts clearly and effectively',
        example: 'She is remarkably articulate during client meetings.',
        speech: 'Number one: articulate. Expressing ideas clearly. Example: She is very articulate.',
        translation: 'Diễn đạt rõ ràng, lưu loát',
        visual: { variant: 'css-magnifying-word', highlightWord: 'Articulate', sceneIcon: 'sparkles' },
      },
      {
        type: 'vocab',
        indexLabel: '02 / 08',
        word: 'Stop saying "Very good" -> Say "Exceptional"',
        meaning: 'Unusually good; standing far above average',
        example: 'Your presentation today was truly exceptional.',
        speech: 'Number two: stop saying very good, say exceptional instead.',
        translation: 'Xuất sắc, vượt trội',
        visual: { variant: 'css-magnifying-word', sceneIcon: 'sparkles' },
      },
      {
        type: 'vocab',
        indexLabel: '03 / 08',
        word: 'Look vs See vs Watch',
        meaning: 'Focus eyes vs notice passively vs observe movement',
        example: 'Watch the screen closely while you look at the pattern.',
        speech: 'Number three: know when to use look, see, and watch.',
        translation: 'Phân biệt look, see và watch',
        visual: { variant: 'trio-icon-cards', labels: ['Look', 'See', 'Watch'], sceneIcon: 'book' },
      },
      {
        type: 'vocab',
        indexLabel: '04 / 08',
        word: 'Pragmatic',
        meaning: 'Practical and focused on real results',
        example: 'Let us take a pragmatic approach to this deadline.',
        speech: 'Number four: pragmatic. Practical and results focused.',
        translation: 'Thực tế, thực dụng theo hướng tích cực',
        visual: { variant: 'phrase-icon-split', sceneIcon: 'briefcase' },
      },
      {
        type: 'vocab',
        indexLabel: '05 / 08',
        word: 'Resilient',
        meaning: 'Able to recover quickly from setbacks',
        example: 'Great learners stay resilient after small mistakes.',
        speech: 'Number five: resilient. Bouncing back fast from difficulties.',
        translation: 'Kiên cường, nhanh chóng phục hồi',
        visual: { variant: 'degree-scale', value: 88, labels: ['Fragile', 'Steady', 'Resilient'] },
      },
      {
        type: 'vocab',
        indexLabel: '06 / 08',
        word: 'Inevitable',
        meaning: 'Certain to happen and impossible to avoid',
        example: 'With daily practice, steady progress is inevitable.',
        speech: 'Number six: inevitable. Certain to happen over time.',
        translation: 'Chắc chắn xảy ra, không thể tránh khỏi',
        visual: { variant: 'css-flashcard-flip', sceneIcon: 'clock' },
      },
      {
        type: 'vocab',
        indexLabel: '07 / 08',
        word: 'Concise',
        meaning: 'Giving clear information in very few words',
        example: 'Keep your email concise so busy teammates read it.',
        speech: 'Number seven: concise. Clear and brief without filler.',
        translation: 'Ngắn gọn, súc tích',
        visual: { variant: 'dialogue-upgrade', labels: ['Long & messy', 'Concise & crisp'] },
      },
      {
        type: 'vocab',
        indexLabel: '08 / 08',
        word: 'Ubiquitous',
        meaning: 'Found everywhere around you',
        example: 'Short videos have become ubiquitous in modern learning.',
        speech: 'Number eight: ubiquitous. Seen and found everywhere.',
        translation: 'Phổ biến khắp mọi nơi',
        visual: { variant: 'bs-alert-tip', sceneIcon: 'globe' },
      },
      {
        type: 'question',
        content: 'Which word means practical and focused on real results?',
        options: ['Articulate', 'Pragmatic', 'Ubiquitous', 'Inevitable'],
        speech: 'Quick check: which word means practical and focused on real results?',
        thinkSec: 4,
      },
      {
        type: 'answer',
        answerIndex: 1,
        explanation: 'Pragmatic describes solving problems practically.',
        speech: 'The answer is B: pragmatic.',
      },
      {
        type: 'outro',
        title: 'Save & Practice Today',
        content: 'Pick 2 words from this list and use them in one sentence today.',
        speech: 'Save this video and try two new words in a sentence today.',
        translation: 'Lưu lại video và đặt câu ngay hôm nay nhé!',
      },
    ],
  });

  const parsed = parseEnglishReelsAiJson(creatorJson, { targetLang: 'vi' });
  assert.ok(parsed, 'Creator JSON should parse cleanly');
  assert.equal(parsed!.title, '8 Words to Sound Smarter in Every Sentence');
  assert.equal(parsed!.mode, 'vocab');
  // 1 title + 8 vocab + 1 merged quiz + 1 outro = 11 cards
  assert.equal(parsed!.cards.length, 11);

  const phrasesParsed = parseEnglishReelsAiJson(
    JSON.stringify({
      mode: 'phrases',
      title: 'Natural English Alternatives',
      cards: [{ type: 'vocab', indexLabel: '01 / 01', word: 'On it', meaning: 'Handling it right now', speech: 'Say on it.' }],
    }),
    { targetLang: 'vi' },
  );
  assert.equal(phrasesParsed?.mode, 'vocab');
  assert.equal(phrasesParsed?.creatorSubMode, 'phrases');

  const firstVocab = parsed!.cards[1];
  assert.equal(firstVocab.indexLabel, '01 / 08');
  assert.ok(firstVocab.ttsText.includes('Number one: articulate'));

  // Zero consecutive duplicate visual.variants (notice item 01 and 02 both asked for css-magnifying-word)
  for (let i = 1; i < parsed!.cards.length; i++) {
    const prevVariant = parsed!.cards[i - 1].visual?.variant;
    const currVariant = parsed!.cards[i].visual?.variant;
    assert.notEqual(
      currVariant,
      prevVariant,
      `Card ${i} repeated visual variant "${currVariant}" consecutively`,
    );
  }

  // Converted project must have zero overlapping elements on stage
  const project = reelCardsToLessonProject(parsed!.cards, {
    title: parsed!.title,
    theme: 'warm-paper',
    targetLang: 'vi',
  });
  const overlaps = findVisualOverlaps(project.elements);
  assert.equal(overlaps.length, 0, `Expected 0 visual overlaps, got ${JSON.stringify(overlaps)}`);
});

test('buildSceneGenerationPrompt uses progressive seg_001/seg_002 samples and resolveSyncAnchorTiming tolerates punctuation variance', () => {
  const cues = [
    { id: 'c1', start: 0.0, end: 3.8, text: 'First compare polite requests at the airport gate.', words: [] },
    { id: 'c2', start: 3.9, end: 7.6, text: 'Then check your boarding pass before entering.', words: [] },
  ];

  const prompt = buildSceneGenerationPrompt(cues, {
    title: 'Airport Polite Requests',
    compositionId: 'ai-decide',
  });
  assert.ok(prompt.includes('seg_001'));
  assert.ok(prompt.includes('seg_002'));

  const segments = buildSourceSegmentsFromCues(cues);
  const timing = resolveSyncAnchorTiming(
    {
      segment_id: 'seg_001',
      anchor_type: 'phrase',
      quote: 'polite requests, at the airport gate',
    },
    segments[0],
    cues,
    0,
    3.8,
  );
  assert.ok(timing.startTime > 0.3 && timing.startTime < 2.2, `expected mid-segment start, got ${timing.startTime}`);
  assert.ok(timing.endTime > timing.startTime && timing.endTime <= 3.8);
});

test('splitMixedLanguageTtsSpans separates mixed EN+VI and JA+VI cleanly and pickVoiceForLangCode rejects mismatched regional voices', () => {
  const enViSpans = splitMixedLanguageTtsSpans('Articulate. Có nghĩa là diễn đạt rõ ràng.', {
    primaryLang: 'en',
    secondaryLang: 'vi',
    primaryVoice: 'en-US-JennyNeural',
    secondaryVoice: 'vi-VN-HoaiMyNeural',
  });
  assert.equal(enViSpans.length, 2);
  assert.equal(enViSpans[0].lang, 'en');
  assert.equal(enViSpans[0].voice, 'en-US-JennyNeural');
  assert.ok(enViSpans[0].text.includes('Articulate.'));
  assert.equal(enViSpans[1].lang, 'vi');
  assert.equal(enViSpans[1].voice, 'vi-VN-HoaiMyNeural');
  assert.ok(enViSpans[1].text.includes('diễn đạt rõ ràng'));

  const jaViSpans = splitMixedLanguageTtsSpans('おはようございます。 Nghĩa là chào buổi sáng 100%.', {
    primaryLang: 'ja',
    secondaryLang: 'vi',
    primaryVoice: 'ja-JP-NanamiNeural',
    secondaryVoice: 'vi-VN-HoaiMyNeural',
  });
  assert.equal(jaViSpans.length, 2);
  assert.equal(jaViSpans[0].lang, 'ja');
  assert.equal(jaViSpans[0].voice, 'ja-JP-NanamiNeural');
  assert.ok(jaViSpans[0].text.includes('おはようございます'));
  assert.equal(jaViSpans[1].lang, 'vi');
  assert.equal(jaViSpans[1].voice, 'vi-VN-HoaiMyNeural');
  assert.ok(jaViSpans[1].text.includes('100%'));

  // Reject mismatched regional voices
  assert.equal(pickVoiceForLangCode('en', 'vi-VN-HoaiMyNeural'), 'en-US-JennyNeural');
  assert.equal(pickVoiceForLangCode('ja', 'vi-VN-NamMinhNeural'), 'ja-JP-NanamiNeural');
  assert.equal(pickVoiceForLangCode('vi', 'en-US-GuyNeural'), 'vi-VN-HoaiMyNeural');
});

test('getLevelsForLearningLanguage returns N5-N1 / A1-C2 / HSK / TOPIK and recommendCreatorItemCount scales with minutes', () => {
  const jaLevels = getLevelsForLearningLanguage('ja').map((l) => l.id);
  assert.deepEqual(jaLevels, ['N5', 'N4', 'N3', 'N2', 'N1', 'N5→N1']);

  const enLevels = getLevelsForLearningLanguage('en').map((l) => l.id);
  assert.deepEqual(enLevels, ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'A1→C2']);

  const zhLevels = getLevelsForLearningLanguage('zh').map((l) => l.id);
  assert.equal(zhLevels[0], 'HSK 1');
  assert.equal(zhLevels[zhLevels.length - 1], 'HSK 1→6');

  const koLevels = getLevelsForLearningLanguage('ko').map((l) => l.id);
  assert.equal(koLevels[0], 'TOPIK 1');
  assert.equal(koLevels[koLevels.length - 1], 'TOPIK 1→6');

  const shortCount = recommendCreatorItemCount(0.5, false);
  const longCount = recommendCreatorItemCount(5, true);
  assert.ok(shortCount >= 4 && shortCount < longCount);
  assert.ok(longCount <= 30 && longCount >= 14);
});

test('buildAiCreatorWebAiPrompt incorporates learningLanguage, dynamic level, minute budget, 16:9 aspect, and dual-TTS explanationSpeech', () => {
  const prompt = buildAiCreatorWebAiPrompt({
    learningLanguage: 'ja',
    level: 'N4',
    durationMinutes: 4,
    targetLang: 'Tiếng Việt',
    aspectRatio: '16:9',
    includeExplanationSpeech: true,
    formatPreference: 'vocab',
  });

  assert.ok(prompt.includes('N4'));
  assert.ok(prompt.includes('4 phút') || prompt.includes('4.0 phút') || prompt.includes('4'));
  assert.ok(prompt.includes('explanationSpeech'));
  assert.ok(prompt.includes('16:9'));
  assert.ok(prompt.includes('日本語') || prompt.includes('Japanese'));
});

test('16:9 landscape dimensions and resolveElementLayoutForAspect arrange visual left and card right without overlap', () => {
  const dims = getStageDimensionsForAspect('16:9');
  assert.deepEqual(dims, { width: 1920, height: 1080 });

  const built = buildReelCardsRuleBased(
    'Articulate: Clear and fluent\nPragmatic: Practical and focused on results',
    { mode: 'vocab', targetLang: 'vi' },
  );
  const project = reelCardsToLessonProject(built.cards, {
    title: 'Landscape 16:9 Lesson',
    theme: 'warm-paper',
    targetLang: 'vi',
    aspectRatio: '16:9',
  });
  assert.equal(project.aspectRatio, '16:9');

  // Inspect a vocab card moment where both illustration-prop and sentence-card are visible
  const vocabCardEl = project.elements.find((el) => el.type === 'sentence-card');
  assert.ok(vocabCardEl, 'Expected at least one sentence-card in converted project');
  const sampleTime = (vocabCardEl!.startTime + vocabCardEl!.endTime) / 2;

  const layoutMap = resolveElementLayoutForAspect(project.elements, sampleTime, '16:9');
  const visibleAtSample = project.elements.filter(
    (el) => sampleTime >= el.startTime && sampleTime <= el.endTime,
  );

  const leftVisual = visibleAtSample.find((el) => el.type === 'illustration-prop' || el.type === 'word-stack');
  const rightCard = visibleAtSample.find((el) => el.type === 'sentence-card' || el.type === 'tone-meter');
  assert.ok(leftVisual, 'Expected visible left visual element');
  assert.ok(rightCard, 'Expected visible right sentence card element');

  const leftBox = layoutMap.get(leftVisual!.id)!;
  const rightBox = layoutMap.get(rightCard!.id)!;
  assert.ok(leftBox.x < 960, `Expected visual on left half (< 960), got x=${leftBox.x}`);
  assert.ok(rightBox.x > 960, `Expected card on right half (> 960), got x=${rightBox.x}`);
  assert.ok(leftBox.x + leftBox.width / 2 <= rightBox.x - rightBox.width / 2 + 20, 'Left visual and right card should not overlap horizontally');

  for (const el of visibleAtSample) {
    const l = layoutMap.get(el.id)!;
    assert.ok(l.x >= 0 && l.x <= 1920, `Element ${el.id} x=${l.x} out of 1920 bounds`);
    assert.ok(l.y >= 0 && l.y <= 1080, `Element ${el.id} y=${l.y} out of 1080 bounds`);
  }
});

test('splitMixedLanguageTtsSpans handles Chinese Hanzi + Pinyin + Vietnamese cleanly without misclassifying English words like day', () => {
  const zhViSpans = splitMixedLanguageTtsSpans('你好。Nghĩa là xin chào.', {
    primaryLang: 'zh',
    secondaryLang: 'vi',
    primaryVoice: 'zh-CN-XiaoxiaoNeural',
    secondaryVoice: 'vi-VN-HoaiMyNeural',
  });
  assert.equal(zhViSpans.length, 2);
  assert.equal(zhViSpans[0].lang, 'zh');
  assert.equal(zhViSpans[0].voice, 'zh-CN-XiaoxiaoNeural');
  assert.ok(zhViSpans[0].text.includes('你好'));
  assert.equal(zhViSpans[1].lang, 'vi');
  assert.equal(zhViSpans[1].voice, 'vi-VN-HoaiMyNeural');
  assert.ok(zhViSpans[1].text.includes('Nghĩa là xin chào'));

  // Parenthesized Pinyin should be stripped before Mandarin TTS so Chinese TTS doesn't spell romanization
  const zhPinyinSpans = splitMixedLanguageTtsSpans('不好意思 (bù hǎo yì si)。Xin lỗi.', {
    primaryLang: 'zh',
    secondaryLang: 'vi',
    primaryVoice: 'zh-CN-XiaoxiaoNeural',
    secondaryVoice: 'vi-VN-HoaiMyNeural',
  });
  assert.equal(zhPinyinSpans[0].lang, 'zh');
  assert.ok(zhPinyinSpans[0].text.includes('不好意思'));
  assert.ok(!zhPinyinSpans[0].text.includes('hǎo'));
  assert.equal(zhPinyinSpans[1].lang, 'vi');

  // Common English word "day" in an English sentence must remain 'en', not 'vi'
  const enDaySpans = splitMixedLanguageTtsSpans('Every day. Nghĩa là mỗi ngày.', {
    primaryLang: 'en',
    secondaryLang: 'vi',
    primaryVoice: 'en-US-JennyNeural',
    secondaryVoice: 'vi-VN-HoaiMyNeural',
  });
  assert.equal(enDaySpans[0].lang, 'en');
  assert.ok(enDaySpans[0].text.includes('Every day'));
  assert.equal(enDaySpans[1].lang, 'vi');
});

test('buildStarterLessonForLanguage(zh) and buildAiCreatorWebAiPrompt(splitAudioByRole) generate pure Chinese Hanzi and role-separated rules', () => {
  const zhStarter = buildStarterLessonForLanguage('zh', 'Tiếng Việt', 'HSK 2');
  assert.ok(zhStarter.title.includes('HSK 2'));
  assert.ok(zhStarter.cards.some((c) => c.type === 'vocab' && /[\u4E00-\u9FFF]/.test(c.ttsText)));
  assert.ok(zhStarter.cards.every((c) => Boolean(c.explanationSpeech)));

  const rolePrompt = buildAiCreatorWebAiPrompt({
    learningLanguage: 'zh',
    level: 'HSK 1',
    durationMinutes: 2,
    targetLang: 'Tiếng Việt',
    includeExplanationSpeech: true,
    splitAudioByRole: true,
  });
  assert.ok(rolePrompt.includes('CRITICAL ROLE-SEPARATED DUAL-TTS RULE'));
  assert.ok(rolePrompt.includes('100% pure Simplified Chinese Hanzi'));
  assert.ok(rolePrompt.includes('"speech": ""'));
  assert.ok(rolePrompt.includes('不好意思'));
});

test('resolveElementLayoutForAspect preserves manualPosition across 16:9 and hitTestElementLayout resolves display coords', () => {
  const built = buildReelCardsRuleBased(
    'Articulate: Clear and fluent\nPragmatic: Practical and focused on results',
    { mode: 'vocab', targetLang: 'vi' },
  );
  const project = reelCardsToLessonProject(built.cards, {
    title: 'Manual Drag Test',
    theme: 'warm-paper',
    targetLang: 'vi',
    aspectRatio: '16:9',
  });
  const cardEl = project.elements.find((el) => el.type === 'sentence-card')!;
  const sampleTime = (cardEl.startTime + cardEl.endTime) / 2;

  const initialHit = hitTestElementLayout(
    project.elements,
    1380,
    540,
    sampleTime,
    '16:9',
  );
  assert.ok(initialHit, 'Expected hitTestElementLayout to hit right-side card in 16:9');
  assert.ok(initialHit!.layout.x > 960);

  const draggedElements = project.elements.map((el) =>
    el.id === initialHit!.element.id
      ? {
          ...el,
          layout: {
            ...el.layout,
            x: 620,
            y: 380,
            width: initialHit!.layout.width,
            scale: initialHit!.layout.scale,
            manualPosition: true,
          },
        }
      : el,
  );
  const afterMap = resolveElementLayoutForAspect(draggedElements, sampleTime, '16:9');
  const movedBox = afterMap.get(initialHit!.element.id)!;
  assert.equal(movedBox.x, 620);
  assert.equal(movedBox.y, 380);
  assert.equal(movedBox.manualPosition, true);
});

