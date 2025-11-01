//
// IMPORT & CONFIG
//
const Alexa = require('ask-sdk-core');
const { CONTENT } = require('./content');

//config der konstanten Variablen
const AUTO_LEVEL_UP_THRESHOLD = 5;
const LEVEL_ORDER = ['leicht', 'mittel', 'schwer'];
const UX_TEST = true;

// Zuordnung der Stories zu den Allgemeinwissenschaftsthemen
const TOPIC_TO_STORY_ID = {
  'geschichte': 'frauenbewegung',
  'wissenschaft': 'penicillin'
};


//
// FUNKTIONEN 
//

//Initialisierung der Anwendung --> scores auf 0 setzen,level auf leicht
function initState(state) {
  state.score  = state.score  || { geschichte: 0, wissenschaft: 0 };
  state.levels = state.levels || { geschichte: 'leicht', wissenschaft: 'leicht' };
  return state;
}

//Für Ux-Test Wissenschafts Score auf 2 setzen; nur wenn UX_TEST = true
function uxTestState(state) {
  initState(state);
  if (UX_TEST && !state._uxDefaultsApplied) {
    state.score.wissenschaft = Math.max(Number(state.score.wissenschaft || 0), 2);
    state._uxDefaultsApplied = true;
  }
  return state;
}

//normalisieren der Nutzereingabe

//alles klein geschrieben + ist String + entfernt Akzente + ß zu ss + cuttet überschüßige Leerzeichen
function normInputText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim();
}

//normalisiert Nutzereingabe (slot)
function getSlotLower(h, slotName) {
  const v2 = Alexa.getSlotValueV2 ? Alexa.getSlotValueV2(h.requestEnvelope, slotName) : null;
  if (v2 && v2.value && v2.value.name) return normInputText(v2.value.name);
  const raw = Alexa.getSlotValue(h.requestEnvelope, slotName);
  return raw ? normInputText(raw) : null;
}

//erster Buchstabe groß --> gut für Aussprache
function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

//backup, damit state vollständig ist und keinen fehler wirft
function ensureTopicState(s, topic) {
  s.score  = s.score  || { geschichte: 0, wissenschaft: 0 };
  s.levels = s.levels || { geschichte: 'leicht', wissenschaft: 'leicht' };
  if (typeof s.score[topic] !== 'number') s.score[topic] = 0;
  if (!s.levels[topic]) s.levels[topic] = 'leicht';
}

//Inhalte aufbereiten,auslesen

//gibt passende Story zurück anhand id (entspricht titel der story)
function getStoryById(id) {
  return CONTENT.stories.find(s => s.id === id);
}

//ermittelt, welche schwierigkeitsstufe als nächstes kommt
function getNextLevel(level) {
  const i = LEVEL_ORDER.indexOf(level);
  if (i < 0 || i === LEVEL_ORDER.length - 1) return null;
  return LEVEL_ORDER[i + 1];
}

//speak Output Funktionen

//erzeugt output für jede frage: Frage... Antwort A... Antwort B...
function buildQuestionSpeech(q) {
  const parts = q.choices.map((o, i) => 'Antwort ' + String.fromCharCode(65 + i) + ': ' + o).join(', ');
  return 'Frage: ' + q.question + '. ' + parts;
}


//bildet output für story mit sprechpausen und nachfrage nach story 
function buildStoryOutput(story) {
  let body = '';
  if (story.ssml && String(story.ssml).trim()) {
    body = story.ssml;
  } else if (Array.isArray(story.story) && story.story.length) {
    body = story.story
      .filter(p => typeof p === 'string' && p.trim().length)
      .join('<break time="500ms"/>');
  } else if (Array.isArray(story.paragraphs) && story.paragraphs.length) {
    body = story.paragraphs
      .filter(p => typeof p === 'string' && p.trim().length)
      .join('<break time="500ms"/>');
  } else if (typeof story.text === 'string' && story.text.trim().length) {
    body = story.text;
  } else if (typeof story.body === 'string' && story.body.trim().length) {
    body = story.body;
  } else {
    body = 'Ich habe leider keinen Text für diese Story gefunden.';
  }

  return '<speak>'
       + body
       + '<break time="1500ms"/> Hast du noch Fragen? '
       + 'Ansonsten sag: Starte das Quiz.'
       + '</speak>';
}

//liest Nutzeraussage nach Slot thema aus
function getChosenTopic(h) {
  const lowered = getSlotLower(h, 'thema'); // z. B. "geschichte" | "wissenschaft"
  return lowered;
}

//liest Slot aus
function getSearchQuery(h, slotName) {
  const v = Alexa.getSlotValue(h.requestEnvelope, slotName);
  return (v || '').trim();
}

//prüft ob Frage nach Definition nach 'Suffragetten' ist
function isSuffragettes(s) {
  const x = normInputText(s);
  return x.includes('suffragett') || x.includes('suffragist') || x.includes('suffrag');
}

//falls nicht nach suffragetten gefragt wird passiert das
function handleOtherDefinition(h, termRaw) {
  return h.responseBuilder
    .speak('Dazu habe ich noch keine hinterlegte Erklärung. Frag mich gerne nach einem anderen Begriff oder sag: Starte das Quiz.')
    .reprompt('Möchtest du eine andere Erklärung hören oder mit dem Quiz starten?')
    .getResponse();
}

//initialisiert den Quiz State
function askQuestion(h, preface) {
  const s    = h.attributesManager.getSessionAttributes();
  const item = s.currentQuiz && s.currentQuiz[s.quizIndex];

  if (!item) {
    s.quizIndex = 0;
    h.attributesManager.setSessionAttributes(s);
    return h.responseBuilder
      .speak('Ich musste das Quiz neu initialisieren. Hier kommt die nächste Frage.')
      .reprompt('Bist du bereit?')
      .getResponse();
  }

  const prompt = buildQuestionSpeech(item);
  s.lastQuestionSpeech = prompt;
  s.state = 'IN_QUIZ';
  h.attributesManager.setSessionAttributes(s);

  const speech = preface ? `${preface} ${prompt}` : prompt;

  return h.responseBuilder
    .speak(speech)
    .reprompt('Antworte mit Antwort A, B, C oder D')
    .getResponse();
}

//indexiert alle möglichen Antwortoptionen und weist ihnen Zahlen zu, dient zur besseren Auswertung
function parseAnswerIndex(h) {
  // 1) A/B/C/D im eigenen Slot
  const opt = getSlotLower(h, 'AntwortOption');
  if (opt) {
    if (opt === 'a') return 0;
    if (opt === 'b') return 1;
    if (opt === 'c') return 2;
    if (opt === 'd') return 3;
  }

  // 2) Zahl 1..4 (AMAZON.NUMBER)
  const numRaw = Alexa.getSlotValue(h.requestEnvelope, 'Zahl');
  if (numRaw) {
    const n = parseInt(numRaw, 10);
    if (n >= 1 && n <= 4) return n - 1;
  }
  const r = h.requestEnvelope.request;
  if (r && r.intent && r.intent.slots && r.intent.slots.Zahl && r.intent.slots.Zahl.value) {
    const zw = normInputText(r.intent.slots.Zahl.value);
    if (zw === 'eins') return 0;
    if (zw === 'zwei') return 1;
    if (zw === 'drei') return 2;
    if (zw === 'vier') return 3;
  }

  // 3) Freitext AMAZON.SearchQuery
  const raw = Alexa.getSlotValue(h.requestEnvelope, 'Antwort');
  if (raw) {
    const x = normInputText(raw);

    if (x.includes('antwort a') || x === 'a') return 0;
    if (x.includes('antwort b') || x === 'b') return 1;
    if (x.includes('antwort c') || x === 'c') return 2;
    if (x.includes('antwort d') || x === 'd') return 3;

    const s = h.attributesManager.getSessionAttributes() || {};
    if (s && s.currentQuiz && Number.isInteger(s.quizIndex)) {
      const item = s.currentQuiz[s.quizIndex];
      if (item && Array.isArray(item.choices)) {
        const idx = matchChoiceIndexByText(x, item.choices);
        if (idx !== null) return idx;
      }
    }
  }

  return null;
}

//normalisiert antwort damit sie besser als freitext verglichen werden kann
function normAnswerforComparison(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9äöü ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

//vergleicht freitext antwort des nutzers mit den antworten der fragen
function matchChoiceIndexByText(userRaw, choices) {
  const u = normAnswerforComparison(userRaw);
  if (!u) return null;

  for (let i = 0; i < choices.length; i++) {
    if (u === normAnswerforComparison(choices[i])) return i;
  }

  const hits = [];
  for (let j = 0; j < choices.length; j++) {
    const cj = normAnswerforComparison(choices[j]);
    if (!cj) continue;
    if (u.indexOf(cj) !== -1 || cj.indexOf(u) !== -1) {
      hits.push({ idx: j, len: cj.length });
    }
  }
  if (hits.length === 1) return hits[0].idx;
  if (hits.length > 1) {
    hits.sort((a, b) => b.len - a.len);
    if (hits[0].len >= (hits[1].len + 3)) return hits[0].idx;
  }
  return null;
}

// startet story, wenn eine mit dem ausgewählten thema vorhanden ist
function handleStartStory(handlerInput) {
  const rb    = handlerInput.responseBuilder;
  const attrs = handlerInput.attributesManager.getSessionAttributes() || {};

  console.log('ATTRS:', JSON.stringify(attrs));
  console.log('ALL STORY IDS:', (CONTENT.stories || []).map(s => s.id));

  if (attrs.state === 'awaiting_story_confirm' && attrs.pendingStoryId) {
    const story = getStoryById(attrs.pendingStoryId);
    if (!story) {
      attrs.state = 'choosing_topic';
      attrs.pendingStoryId = null;
      handlerInput.attributesManager.setSessionAttributes(attrs);

      return rb
        .speak('Die Story konnte nicht geladen werden. Wähle bitte eins dieser beiden Themen: Geschichte oder Wissenschaft?')
        .reprompt('Wähle heute zwischen Geschichte oder Wissenschaft.')
        .addElicitSlotDirective('thema')
        .getResponse();
    }

    const ssml = buildStoryOutput(story);

    attrs.state = 'after_story';
    attrs.lastStoryId = story.id;
    attrs.pendingStoryId = null;
    handlerInput.attributesManager.setSessionAttributes(attrs);

    return rb
      .speak(ssml)
      .reprompt("Wenn du bereit bist, sag: 'Starte das Quiz'. Oder stell mir eine Frage.")
      .getResponse();
  }

  return rb
    .speak("Wobei soll ich weitermachen? Sag 'Hilfe' oder 'Anleitung' um mehr über die Funktionen zu erfahren")
    .reprompt('Sag zum Beispiel: Starte Lerneinheit.')
    .getResponse();
}

//rechnet gesamten score aus allen themen aus
function totalScore(s) {
  s.score = s.score || { geschichte: 0, wissenschaft: 0 };
  const g = Number(s.score.geschichte || 0);
  const w = Number(s.score.wissenschaft || 0);
  return g + w;
}

//empfehlungen nach gesamt punktezahlen
function buildSimpleRecommendation(s) {
  const total = totalScore(s);
  if (total >= 12) {
    return 'Stark. Du hast heute richtig viel geschafft. Nimm dir fürs nächste Mal ein neues Thema vor oder setz dir ein Ziel von fünf richtigen Antworten am Stück.';
  }
  if (total >= 8) {
    return 'Sehr gut. Bleib in deinem aktuellen Thema und steigere das Tempo. Wenn du magst, wechsle danach zur Abwechslung das Thema.';
  }
  if (total >= 5) {
    return 'Ich finde, das lief heute sehr gut. Lass uns daran das nächste Mal anknüpfen und genauso weiter machen. ';
  }
  if (total >= 3) {
    return 'Guter Anfang. Wiederhole kurz die Story und mach dann das Quiz auf demselben Level weiter.';
  }
  if (total >= 1) {
    return 'Dranbleiben lohnt sich. Starte beim nächsten Mal direkt mit dem Quiz, damit du in den Flow kommst.';
  }
  return 'Lass uns beim nächsten Mal mit einer kurzen Story starten und danach direkt ins Quiz gehen.';
}


//
// HANDLER
//

//startet den skill
const LaunchRequestHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'LaunchRequest'; },
  handle(h) {
    const s = h.attributesManager.getSessionAttributes() || {};
    initState(s);
    uxTestState(s);
    h.attributesManager.setSessionAttributes(s);

    const speech = "Willkommen bei LernBuddy. Gemeinsam können wir dein Allgemeinwissen verbessern. Möchtest du loslegen? Dann sag: 'Starte Lerneinheit'" + '<break time="400ms"/> ' + "Soll ich dir erklären, wie alles funktioniert? Dann sag: 'Anleitung'";
    return h.responseBuilder
      .speak(speech)
      .reprompt("Möchtest du loslegen? Dann sag: 'Starte Lerneinheit'. Soll ich dir erklären, wie alles funktioniert? Dann sag: 'Anleitung'")
      .getResponse();
  }
};

//startet lerneinheit
const StartLessonIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
        && Alexa.getIntentName(h.requestEnvelope) === 'StartLessonIntent';
  },
  handle(h) {
    const speechText = 'Ich schlage dir folgende Themen vor, um dein Allgemeinwissen zu verbessern: Geschichte, Wissenschaft, Politik, Kunst, Geografie, Sprache. Welches Thema möchtest du heute behandeln?';
    return h.responseBuilder
      .speak(speechText)
      .reprompt('Welches Thema wählst du? Wissenschaft, Politik, Geografie, Sprache, Kunst oder Geschichte?')
      .getResponse();
  }
};

//gibt anleitung aus
const InstructionsIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
        && Alexa.getIntentName(h.requestEnvelope) === 'InstructionsIntent';
  },
  handle(h) {
    const speechText = "Wir werden gemeinsam lernen, indem ich dir zu einem allgemeinwissenschaftlichen Thema deiner Wahl eine Geschichte erzähle. Das Ganze basiert auf der Lernmethode Storytelling und soll dir helfen die Inhalte besser zu verinnerlichen. Natürlich hast du die Möglichkeit mich nach weiteren Erklärungen zu fragen. Zum Schluss stelle ich dir ein paar Quizfragen. Soll ich dir noch mehr erklären, dann sag ‘Hilfe’. Möchtest du loslegen? Dann sag: 'Starte Lerneinheit'";
    return h.responseBuilder
      .speak(speechText)
      .reprompt('Willst du wissen, was du zum Beispiel zu mir sagen kannst, dann frag um Hilfe.')
      .getResponse();
  }
};

//handelt die themenauswahl
const ChooseTopicIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
        && Alexa.getIntentName(h.requestEnvelope) === 'ChooseTopicIntent';
  },
  handle(h) {
    const rb = h.responseBuilder;
    const s  = h.attributesManager.getSessionAttributes() || {};

    const choice = getChosenTopic(h);
    if (!choice) {
      const hint = 'Wissenschaft oder Geschichte?';
      return rb.speak('Welches Thema möchtest du heute behandeln? ' + hint)
               .reprompt(hint)
               .addElicitSlotDirective('thema')
               .getResponse();
    }

    const storyId = TOPIC_TO_STORY_ID[choice];
    const story   = storyId ? getStoryById(storyId) : null;
    if (!story) {
      const avail = Object.keys(TOPIC_TO_STORY_ID).join(' oder ');
      return rb.speak('Hierzu gibt es noch keine Story. Verfügbar sind ' + avail + '. Welches Thema möchtest du?')
               .reprompt('Wähle heute zwischen Geschichte oder Wissenschaft')
               .addElicitSlotDirective('thema')
               .getResponse();
    }

    s.learnTopic     = choice;
    s.pendingStoryId = story.id;
    s.state          = 'awaiting_story_confirm';
    h.attributesManager.setSessionAttributes(s);

    const title = story.title || 'der nächsten Story';
    return rb.speak('Du hast dich für das Thema ' + cap(choice) + ' entschieden. Meine erste Story handelt von ' + title + '. Soll ich anfangen?')
             .reprompt('Soll ich mit der Story anfangen?')
             .getResponse();
  }
};

//beginnt mit der story, wenn nutzer ja sagt
const YesIntentHandler = {
  canHandle(h) {
    const r = h.requestEnvelope.request;
    return r && r.type === 'IntentRequest' && r.intent && r.intent.name === 'AMAZON.YesIntent';
  },
  handle(h) {
    return handleStartStory(h);
  }
};

//beginnt mit der sotry wenn nutzer hinterlegte utterances sagt
const TellStoryIntentHandler = {
  canHandle(h) {
    const r = h.requestEnvelope.request;
    return r && r.type === 'IntentRequest' && r.intent && r.intent.name === 'TellStoryIntent';
  },
  handle(h) {
    return handleStartStory(h);
  }
};

//handelt frage nach Definition
const AskDefinitionIntentHandler = {
  canHandle(h) {
    const r = h.requestEnvelope.request;
    return r && r.type === 'IntentRequest' && r.intent && r.intent.name === 'AskDefinitionIntent';
  },
  handle(h) {
    const rb = h.responseBuilder;
    const s  = h.attributesManager.getSessionAttributes() || {};
    const termRaw = getSearchQuery(h, 'Begriff');

    console.log('AskDefinition termRaw=', termRaw, 'state=', s.state);

    if (!termRaw) {
      return rb
        .speak('Welchen Begriff soll ich erklären?')
        .reprompt('Sag zum Beispiel: Erkläre Suffragetten.')
        .addElicitSlotDirective('Begriff')
        .getResponse();
    }

    if (isSuffragettes(termRaw)) {
      const explainBody =
        'Suffragetten waren Aktivistinnen, die zu Beginn des 20. Jahrhunderts vor allem in Großbritannien für das Frauenwahlrecht kämpften. ' +
        '<break time="400ms"/> ' +
        'Der Name leitet sich vom englischen Wort <lang xml:lang="en-US">suffrage</lang> für Wahlrecht ab. ' +
        '<break time="400ms"/> ' +
        'Sie organisierten Demonstrationen und setzten teilweise zivilen Ungehorsam ein. ' +
        '<break time="400ms"/> ' +
        'In Großbritannien durften Frauen ab 1918 eingeschränkt wählen, ab 1928 zu gleichen Bedingungen wie Männer.';

      if (s.state === 'IN_QUIZ' && s.lastQuestionSpeech) {
        const ssml =
          '<speak>' + explainBody + ' <break time="600ms"/> ' +
          'Hier ist wieder deine Frage. ' + s.lastQuestionSpeech + '</speak>';
        console.log('AskDefinition IN_QUIZ ssml=', ssml);
        return rb.speak(ssml)
                 .reprompt('Antworte mit Antwort A, B, C oder D oder sag den Inhalt der Antwort.')
                 .getResponse();
      }

      const ssml =
        '<speak>' + explainBody + ' <break time="600ms"/> ' +
        'Möchtest du weitermachen? Du kannst das Quiz starten oder ein Thema wechseln.' + '</speak>';
      console.log('AskDefinition ssml=', ssml);
      return rb.speak(ssml)
               .reprompt('Wie möchtest du weitermachen?')
               .getResponse();
    }

    return handleOtherDefinition(h, termRaw);
  }
};


//startet das quiz
const StartQuizIntentHandler = {
  canHandle(h) {
    const r = h.requestEnvelope.request;
    return r && r.type === 'IntentRequest' && r.intent && r.intent.name === 'StartQuizIntent';
  },
  handle(h) {
    const rb = h.responseBuilder;
    const s  = h.attributesManager.getSessionAttributes() || {};

    const topic = s.learnTopic || getChosenTopic(h);
    if (!topic) {
      return rb.speak('Für welches Thema soll ich das Quiz starten? Wähle Thema Geschichte oder Wissenschaft')
               .reprompt('Wähle zwischen Geschichte oder Wissenschaft.')
               .addElicitSlotDirective('thema')
               .getResponse();
    }

    ensureTopicState(s, topic);
    const level = s.levels[topic];

    const story = getStoryById(TOPIC_TO_STORY_ID[topic]);
    const block = story && story.quiz && story.quiz.levels && story.quiz.levels[level] ? story.quiz.levels[level] : null;
    if (!block || !block.length) {
      return rb.speak('Für dieses Thema habe ich keinen Fragenblock. Wähle bitte ein anderes Thema.')
               .reprompt('Wähle zwischen Geschichte oder Wissenschaft.')
               .getResponse();
    }

    s.state         = 'IN_QUIZ';
    s.currentTopic  = topic;
    s.currentStoryId= story.id;
    s.currentLevel  = level;
    s.currentQuiz   = block;
    s.quizIndex     = 0;
    h.attributesManager.setSessionAttributes(s);

    const pre = 'Okay, wir starten das Quiz in ' + cap(topic) + ' auf ' + level + '.';
    return askQuestion(h, pre);
  }
};

//handelt die antworten des nutzers im quiz
const AnswerIntentHandler = {
  canHandle(h) {
    const r = h.requestEnvelope.request;
    return r && r.type === 'IntentRequest' && r.intent && r.intent.name === 'AnswerIntent';
  },
  handle(h) {
    console.log('SLOTS@AnswerIntent:', JSON.stringify(h.requestEnvelope.request.intent && h.requestEnvelope.request.intent.slots, null, 2));

    const rb = h.responseBuilder;
    const s  = h.attributesManager.getSessionAttributes() || {};

    if (s.state !== 'IN_QUIZ' || !Array.isArray(s.currentQuiz)) {
      return rb.speak('Wir sind nicht im Quiz. Sag: Starte das Quiz.')
               .reprompt('Sag: Starte das Quiz.')
               .getResponse();
    }

    if (typeof s.quizIndex !== 'number' || !s.currentQuiz[s.quizIndex]) {
      s.quizIndex = 0;
      h.attributesManager.setSessionAttributes(s);
      return rb.speak('Ich starte die aktuelle Frage neu.').reprompt('Bereit?').getResponse();
    }

    const topic = s.currentTopic;
    ensureTopicState(s, topic);

    const item    = s.currentQuiz[s.quizIndex];
    const userIdx = parseAnswerIndex(h);
    if (userIdx === null) {
      return rb.speak('Welche Option wählst du? Antworte mit Antwort A, B, C oder D')
               .reprompt('Sag zum Beispiel: Antwort A. Oder sag den Inhalt der Antwort')
               .getResponse();
    }

    const correctIdx = item.correct_index;
    const correct    = userIdx === correctIdx;

    let speak;
    if (correct) {
      s.score[topic] += 1;
      speak = 'Sehr gut, das ist richtig. Nächste ';

      const current = s.levels[topic];
      const next    = getNextLevel(current);
      if (s.score[topic] >= AUTO_LEVEL_UP_THRESHOLD && next) {
        s.levels[topic] = next;
        s.currentLevel  = next;
        const story     = getStoryById(s.currentStoryId);
        s.currentQuiz   = story.quiz.levels[next];
        s.quizIndex     = 0;
        h.attributesManager.setSessionAttributes(s);
        return askQuestion(h, speak + 'Dein Schwierigkeitsgrad steigt auf ' + next + '.');
      }
    } else {
      const letter = String.fromCharCode(65 + correctIdx);
      const text   = item.choices[correctIdx];
      speak = 'Leider falsch. Die richtige Antwort wäre Antwort ' + letter + ': ' + text + '. Nächste ';
    }

    if (s.quizIndex < s.currentQuiz.length - 1) s.quizIndex += 1;
    else s.quizIndex = 0;

    h.attributesManager.setSessionAttributes(s);
    return askQuestion(h, speak);
  }
};

//wiederholen der frage
const RepeatQuestionIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
        && Alexa.getIntentName(h.requestEnvelope) === 'RepeatQuestionIntent';
  },
  handle(h) {
    const s = h.attributesManager.getSessionAttributes() || {};

    if (s.state === 'IN_QUIZ' && s.lastQuestionSpeech) {
      return h.responseBuilder
        .speak(s.lastQuestionSpeech)
        .reprompt('Antworte mit Antwort A, B, C oder D.')
        .getResponse();
    }

    return h.responseBuilder
      .speak('Es gibt gerade keine Frage zu wiederholen. Möchtest du ein Quiz starten?')
      .reprompt('Sag: Starte das Quiz.')
      .getResponse();
  }
};

//punktestand ausgeben
const GetScoreIntentHandler = {
  canHandle(h) {
    const r = h.requestEnvelope.request;
    return r && r.type === 'IntentRequest' && r.intent && r.intent.name === 'GetScoreIntent';
  },
  handle(h) {
    const rb = h.responseBuilder;
    const s  = h.attributesManager.getSessionAttributes() || {};

    s.score  = s.score  || { geschichte: 0, wissenschaft: 0 };
    s.levels = s.levels || { geschichte: 'leicht', wissenschaft: 'leicht' };

    const topic = getSlotLower(h, 'Thema');

    if (topic && Object.prototype.hasOwnProperty.call(s.score, topic)) {
      ensureTopicState(s, topic);
      const pts = s.score[topic];
      const label = cap(topic);
      return rb
        .speak(`Dein Punktestand in ${label} ist ${pts} Punkte.`)
        .reprompt('Möchtest du weitermachen? Sag: Starte das Quiz.')
        .getResponse();
    }

    const a = `Geschichte: ${s.score.geschichte} Punkte`;
    const b = `Wissenschaft: ${s.score.wissenschaft} Punkte`;
    return rb
      .speak(`${a} ${b}`)
      .reprompt('Möchtest du weitermachen? Dann starte die Lerneinheit oder das Quiz.')
      .getResponse();
  }
};

//empfehlungen
const RecommendationIntentHandler = {
  canHandle(h) {
    const r = h.requestEnvelope.request;
    return r && r.type === 'IntentRequest' && r.intent && r.intent.name === 'RecommendationIntent';
  },
  handle(h) {
    const s = h.attributesManager.getSessionAttributes() || {};
    s.score  = s.score  || { geschichte: 0, wissenschaft: 0 };
    s.levels = s.levels || { geschichte: 'leicht', wissenschaft: 'leicht' };

    const rec = buildSimpleRecommendation(s);
    return h.responseBuilder
      .speak(`Meine Empfehlung für das nächste Mal: ${rec}`)
      .reprompt('Wie möchtest du weitermachen? Du kannst das Quiz starten oder ein Thema wechseln.')
      .getResponse();
  }
};

//schwierigkeitsgrade
const LevelInfoIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
        && Alexa.getIntentName(h.requestEnvelope) === 'LevelInfoIntent';
  },
  handle(h) {
    const rb = h.responseBuilder;
    const s  = h.attributesManager.getSessionAttributes() || {};

    s.score  = s.score  || { geschichte: 0, wissenschaft: 0 };
    s.levels = s.levels || { geschichte: 'leicht', wissenschaft: 'leicht' };

    const thr = AUTO_LEVEL_UP_THRESHOLD;

    function line(topicKey) {
      const lvl   = s.levels[topicKey] || 'leicht';
      const pts   = Number(s.score[topicKey] || 0);
      const need  = Math.max(thr - pts, 0);
      const label = topicKey === 'geschichte' ? 'Geschichte' : 'Wissenschaft';
      const upInfo = need > 0
        ? ` Noch ${need} ${need === 1 ? 'Punkt' : 'Punkte'} bis zum automatischen Aufstieg.`
        : ' Aufstiegsgrenze erreicht oder bereits erhöht.';
      return `${label}: ${lvl}.${upInfo}`;
    }

    const speech =
      `Deine aktuellen Level sind: In ${line('geschichte')} und in ${line('wissenschaft')} ` +
      `Die Schwierigkeit erhöht sich automatisch, sobald du in einem Thema ${thr} Punkte erreicht hast.`;

    return rb
      .speak(speech)
      .reprompt('Wie möchtest du weitermachen? Starte das Quiz oder wechsle das Thema.')
      .getResponse();
  }
};

//beendet die lerneinheit
const EndLearnSessionIntentHandler = {
  canHandle(h) {
    const r = h.requestEnvelope.request;
    return r && r.type === 'IntentRequest' && r.intent && r.intent.name === 'EndLearnSessionIntent';
  },
  handle(h) {
    const speechText = 'Bis zum nächsten Mal!';
    return h.responseBuilder
      .speak(speechText)
      .withShouldEndSession(true)
      .getResponse();
  }
};

//handelt hilfe anfrage
const HelpIntentHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.HelpIntent'; },
  handle(h) {
    const speech = `Möchtest du unsere Einheit beginnen, dann sag: ‘Starte Lerneinheit’. Brauchst du eine Erklärung, wie alles funktioniert, dann sag: ‘Anleitung’. Möchtest du deinen Punktestand wissen, dann sag zum Beispiel: ‘Punktestand in Thema Geschichte’. Möchtest du dein Thema wechseln, sag zum Beispiel: ‘Wechsle zum Thema Kunst’.`;
    return h.responseBuilder.speak(speech).reprompt("Was möchtest du tun?").getResponse();
  }
};

//vordefinierte nötige handler
const ExitIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' &&
      (Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.CancelIntent' ||
       Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.StopIntent');
  },
  handle(h) { return h.responseBuilder.speak("Bis zum nächsten Mal!").withShouldEndSession(true).getResponse(); }
};

const FallbackIntentHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.FallbackIntent'; },
  handle(h) { return h.responseBuilder.speak("Tut mir leid, dass habe ich leider nicht verstanden. Soll ich dir meine Funktionen erklären, dann sag: ‘Hilfe’.").reprompt("Tut mir leid, diese Funktion ist noch nicht möglich.").getResponse(); }
};

const SessionEndedRequestHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'SessionEndedRequest'; },
  handle(h) { return h.responseBuilder.getResponse(); }
};

const ErrorHandler = {
  canHandle() { return true; },
  handle(h, err) {
    console.log(`Error: ${err && err.stack || err}`);
    return h.responseBuilder.speak("Da ist etwas schiefgelaufen. Bitte sag es nochmal.").reprompt("Bitte wiederhole deine Eingabe.").getResponse();
  }
};

//
// EXPORT
//
exports.handler = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    StartLessonIntentHandler,
    InstructionsIntentHandler,
    ChooseTopicIntentHandler,
    TellStoryIntentHandler,
    YesIntentHandler,
    AskDefinitionIntentHandler,
    StartQuizIntentHandler,
    AnswerIntentHandler,
    RepeatQuestionIntentHandler,
    GetScoreIntentHandler,
    RecommendationIntentHandler,
    LevelInfoIntentHandler,
    EndLearnSessionIntentHandler,
    HelpIntentHandler,
    ExitIntentHandler,
    FallbackIntentHandler,
    SessionEndedRequestHandler,
  )
  .addErrorHandlers(ErrorHandler)
  .lambda();
