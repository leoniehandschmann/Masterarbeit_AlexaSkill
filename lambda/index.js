const Alexa = require('ask-sdk-core');
const request = require('sync-request');
//const { OPENAI_API_KEY } = require('./config.js')
const OPENAI_API_KEY = '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';
const { CONTENT } = require('./content')
const DIFF_ORDER = ['easy', 'medium', 'hard'];
const THRESHOLD = 3; // 10 richtige pro Stufe

//const { DynamoDbPersistenceAdapter } = require('ask-sdk-dynamodb-persistence-adapter');

//const persistenceAdapter = new DynamoDbPersistenceAdapter({
  //tableName: 'LernBuddyProgress',
  //createTable: true
//});

// --- DynamoDB optional laden + Alexa-Hosted sicher nutzen ---
// --- DynamoDB-Adapter für Alexa-Hosted: nur verwenden, wenn die Hosted-Tabelle vorhanden ist ---
let DynamoDbPersistenceAdapter;
try {
  ({ DynamoDbPersistenceAdapter } = require('ask-sdk-dynamodb-persistence-adapter'));
  console.log('DDB Adapter geladen');
} catch (e) {
  console.log('DDB Adapter NICHT installiert, starte ohne Persistenz');
}

const hostedTable = process.env.DYNAMODB_TABLE_NAME; // Wird gesetzt, wenn in der Console "Data Storage: DynamoDB" aktiv ist
let persistenceAdapter = null;

if (DynamoDbPersistenceAdapter && hostedTable) {
  console.log('Nutze Hosted DDB Table:', hostedTable);
  // In Alexa-Hosted: KEIN createTable, sonst 403
  persistenceAdapter = new DynamoDbPersistenceAdapter({
    tableName: hostedTable,
    createTable: false
  });
} else {
  console.log('Keine Hosted DDB Table gefunden – starte ohne Persistenz');
}


function getQuestionsFor(storyId) {
  const story = CONTENT.stories.find(s => s.storyId === storyId);
  if (!story) throw new Error(`Story ${storyId} nicht gefunden`);
  return { easy: story.quiz.easy, medium: story.quiz.medium, hard: story.quiz.hard };
}

function defaultProgress(storyId) {
  return { storyId, correct: { easy: [], medium: [], hard: [] }, currentDifficulty: 'easy' };
}

function computeCurrentDifficulty(progress) {
  for (var i = 0; i < DIFF_ORDER.length; i++) {
    var level = DIFF_ORDER[i];
    var count = 0;
    if (progress && progress.correct && progress.correct[level] && Array.isArray(progress.correct[level])) {
      count = progress.correct[level].length;
    }
    if (count < THRESHOLD) return level;
  }
  return 'done';
}

function pickNextQuestion(progress) {
  if (!progress || !progress.storyId) {
    console.log('pickNextQuestion: fehlender progress/storyId');
    return { status: 'finished' };
  }

  const diff = computeCurrentDifficulty(progress);
  if (diff === 'done') return { status: 'finished' };

  let buckets;
  try {
    buckets = getQuestionsFor(progress.storyId);
  } catch (e) {
    console.log('pickNextQuestion/getQuestionsFor error:', e && e.message ? e.message : e);
    return { status: 'finished' };
  }

  const all = (buckets && buckets[diff]) ? buckets[diff] : [];
  if (!Array.isArray(all) || all.length === 0) {
    const idx = DIFF_ORDER.indexOf(diff);
    if (idx >= 0 && idx < DIFF_ORDER.length - 1) {
      progress.currentDifficulty = DIFF_ORDER[idx + 1];
      return pickNextQuestion(progress);
    }
    return { status: 'finished' };
  }

  const solved = new Set(Array.isArray(progress.correct[diff]) ? progress.correct[diff] : []);
  const pool = all.filter(q => q && q.id && !solved.has(q.id));

  if (pool.length === 0) {
    const idx = DIFF_ORDER.indexOf(diff);
    if (idx >= 0 && idx < DIFF_ORDER.length - 1) {
      progress.currentDifficulty = DIFF_ORDER[idx + 1];
      return pickNextQuestion(progress);
    }
    return { status: 'finished' };
  }

  const rand = pool[Math.floor(Math.random() * pool.length)];
  progress.currentDifficulty = diff;
  return { status: 'ok', difficulty: diff, question: rand };
}


function isCorrect(userAnswer, question) {
  const norm = s => String(s).trim().toLowerCase();
  return norm(userAnswer) === norm(question.answer);
}

function normalize(v) {
  if (!v) return null;
  const t = String(v).toLowerCase();
  if (t.includes('kurz') || t.includes('10')) return 'kurz';
  if (t.includes('mittel') || t.includes('20')) return 'mittel';
  if (t.includes('lang') || t.includes('30')) return 'lang';
  return null;
}

// Hilfsfunktion lokal definieren
function getStoryById(id) {
  return CONTENT.stories.find(s => s.storyId === id) || null;
}

// optional: nummerierten Story-String in Sätze auftrennen
function splitNumberedStory(story) {
  if (!story || typeof story !== 'string') return [];
  const cleaned = story.replace(/^\s*\d+\s/, '');
  const parts = cleaned.split(/\s(?=\d+\s)/g).map(p => p.replace(/^\d+\s/, '').trim());
  return parts.filter(Boolean);
}

// Lädt alle gespeicherten Fortschritte (robust, auch ohne Adapter)
async function loadProgress(h, storyId) {
  try {
    const mgr = h.attributesManager;
    const all = await mgr.getPersistentAttributes() || {};
    const byStory = all.progressByStory || {};
    return byStory[storyId] || null;
  } catch (e) {
    console.log('loadProgress: keine Persistenz oder Fehler:', e && e.message ? e.message : e);
    return null;
  }
}

// Speichert Fortschritt (robust, schluckt Fehler wenn kein Adapter)
async function saveProgress(h, storyId, progress) {
  try {
    const mgr = h.attributesManager;
    const all = await mgr.getPersistentAttributes() || {};
    const byStory = all.progressByStory || {};
    byStory[storyId] = progress;
    all.progressByStory = byStory;
    mgr.setPersistentAttributes(all);
    await mgr.savePersistentAttributes();
  } catch (e) {
    console.log('saveProgress: keine Persistenz oder Fehler:', e && e.message ? e.message : e);
  }
}



const LaunchRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
    },
    handle(handlerInput) {
        const speakOutput = 'Hallo und Willkommen zu deinem Lern Buddy! Ich möchte dir helfen, dein Allgemeinwissen zu verbessern. Wie lange möchtest du heute Lernen?';

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(speakOutput)
            .getResponse();
    }
};

const ChooseLearnTimeIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'ChooseLearnTimeIntent';
    },
    handle(handlerInput) {
        const resBuilder = handlerInput.responseBuilder;
        const attributes = handlerInput.attributesManager.getSessionAttributes();

    const learnTime_slot = Alexa.getSlot(handlerInput.requestEnvelope, 'learn_time'); //objekt
    const raw = learnTime_slot && learnTime_slot.value;                             // String
    const choice = normalize(raw);                                       //kurz,mittel,lang
    

    if (!choice) {
      return resBuilder
        .speak('Wie lange möchtest du lernen. Kurz, mittel oder lang.')
        .reprompt('Sag kurz, mittel oder lang.')
        .addElicitSlotDirective('learn_time')
        .getResponse();
    }

    // Sessionattribut setzen
    attributes.learnTime = choice;
    handlerInput.attributesManager.setSessionAttributes(attributes);

    return resBuilder
      .speak(`Okay. Für diese Session lernen wir ${choice}. Welches Thema möchtest du heute behandeln?`)
      .getResponse();
    }
}


const ChooseTopicIntentHandler = {
     canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'ChooseTopicIntent';
    },
    handle(handlerInput) {
        const resBuilder = handlerInput.responseBuilder;
        const attributes = handlerInput.attributesManager.getSessionAttributes();

    const learnTopic_slot = Alexa.getSlot(handlerInput.requestEnvelope, 'learn_topic'); 
    const raw = learnTopic_slot && learnTopic_slot.value;                            
    const choice = raw;                                       
    

    if (!choice) {
      return resBuilder
        .speak('Welches Thema möchtest du heute behandeln?')
        .reprompt('Entscheide dich zwischen Wissenschaft, Politik, Geografie, Sprache, Kunst oder Geschichte')
        .addElicitSlotDirective('learn_topic')
        .getResponse();
    }

    // Sessionattribut setzen
    attributes.learnTopic = choice;
    handlerInput.attributesManager.setSessionAttributes(attributes);

    return resBuilder
      .speak(`Wenn du mit dem Thema ${choice} beginnen möchtest, sag 'Start'.`)
      .getResponse();
    }
}

const GPTIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'GPTIntent';
    },
    handle(handlerInput) {
        var speakOutput = 'Hello World!';

        const catchAllValue = handlerInput.requestEnvelope.request.intent.slots.catchAll.value;
        console.log ('User sagt:', catchAllValue);
        
        const apiKey = (process.env.OPENAI_API_KEY || OPENAI_API_KEY || '');
        const keyInfo = {
            present: Boolean(apiKey),
            length: apiKey ? apiKey.length : 0,
            looksLikeOpenAI: apiKey ? apiKey.startsWith('sk-') : false
        };
        console.log('OPENAI key check:', keyInfo);
        if (!apiKey) {
        console.error('OPENAI_API_KEY fehlt oder ist leer');
        return handlerInput.responseBuilder
            .speak('Der externe Dienst ist gerade nicht erreichbar.')
            .getResponse();
        }

        
        function makeSyncPostRequest(){
            
            try{
                const response = request('POST', 'https://api.openai.com/v1/chat/completions', {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + OPENAI_API_KEY,
                        //Add any other headers if needed
                    },
                    body: JSON.stringify({
                        "model": "gpt-5-mini",
                        "max-tokens": 150,
                        "messages": [{"role":"system", "content": "antworte kurz,klar und in 2-3 Sätzen"},{"role": "user", "content": catchAllValue}]
                    })
                });
                //check the response status code 
                if (response.statusCode === 200){
                    speakOutput = JSON.parse(response.getBody('utf-8'));
                    speakOutput = speakOutput.choices[0].message.content;
                    
                    console.log('response:' , speakOutput);
                    
                } else {
                    console.error('Failed with status code: ', response.statusCode);
                    const errBody = response.getBody('utf-8');
                    console.error('OpenAI 429:', errBody);
                }
                
            }
            catch (error){
                console.error('Error:',error.message);
            }
            
        }
        
        makeSyncPostRequest();

        return handlerInput.responseBuilder
            .speak(speakOutput)
            //.reprompt('add a reprompt if you want to keep the session open for the user to respond')
            .getResponse();
    }
};

const HelpIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
    },
    handle(handlerInput) {
        const speakOutput = 'You can say hello to me! How can I help?';

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(speakOutput)
            .getResponse();
    }
};


const TellStoryIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'TellStoryIntent';
  },
  handle(h) {
    const rb = h.responseBuilder;
    const s = getStoryById('S3');
    if (!s) return rb.speak('Ich finde die Story nicht.').getResponse();

    const parts = splitNumberedStory(s.story);
    const storyText = parts.slice(0, 4).join(' '); // z. B. die ersten 4 Sätze

    const ssml = `<speak>${storyText}<break time="2s"/>Sollen wir mit den Fragen beginnen?</speak>`;

    return rb
      .speak(ssml)                                 // SSML erlaubt die Pause
      .reprompt('Sollen wir mit den Fragen beginnen?')
      .getResponse();
  }
};



const AskQuestionsIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
        && Alexa.getIntentName(h.requestEnvelope) === 'AskQuestionsIntent';
  },
  async handle(h) {
  const rb = h.responseBuilder;
  const session = h.attributesManager.getSessionAttributes();
  const storyId = 'S3';

  try {
    // Story vorhanden?
    const storyExists = !!(CONTENT && Array.isArray(CONTENT.stories) && CONTENT.stories.find(s => s.storyId === storyId));
    if (!storyExists) {
      console.log('AskQuestions: Story nicht gefunden:', storyId);
      return rb.speak('Ich finde die Story nicht.').getResponse();
    }

    // Fortschritt laden oder initialisieren
    let persisted = await loadProgress(h, storyId);
    if (!persisted || persisted.storyId !== storyId) {
      persisted = defaultProgress(storyId);
      await saveProgress(h, storyId, persisted); // speichere direkt, falls Persistenz aktiv ist
    }
    session.progress = persisted;

    // Nächste Frage
    const res = pickNextQuestion(session.progress);
    if (!res || res.status === 'finished') {
      return rb.speak('Diese Story ist abgeschlossen. Willst du eine andere Story wählen?')
               .reprompt('Andere Story?').getResponse();
    }

    // Frage merken & sprechen
    session.currentQuestionId = res.question.id;
    const q = res.question;
    const speech = `Kategorie ${res.difficulty}. ${q.question} `
                 + q.options.map((opt, i) => `Option ${i + 1}: ${opt}.`).join(' ');

    return rb.speak(speech).reprompt('Welche Option wählst du?').getResponse();

  } catch (e) {
    console.error('AskQuestionsIntentHandler catch:', e && e.stack ? e.stack : e);
    return rb.speak('Da ist gerade ein Fehler passiert. Sollen wir es noch einmal versuchen?')
             .reprompt('Soll ich die Fragen stellen?')
             .getResponse();
  }
}

};

const AnswerCheckIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
        && Alexa.getIntentName(h.requestEnvelope) === 'AnswerCheckIntent';
  },
  async handle(h) {
    const rb = h.responseBuilder;
    const session = h.attributesManager.getSessionAttributes();
    const { progress, currentQuestionId } = session || {};

    if (!progress || !currentQuestionId) {
      return rb.speak('Wir sind gerade in keiner Fragerunde. Soll ich mit den Fragen beginnen?')
               .reprompt('Soll ich beginnen?').getResponse();
    }

    // Aktuelle Frage suchen
    const qs = getQuestionsFor(progress.storyId);
    const allQs = [].concat(qs.easy, qs.medium, qs.hard);
    const question = allQs.find(q => q.id === currentQuestionId);
    if (!question) {
      session.progress = defaultProgress(progress.storyId);
      return rb.speak('Da stimmt etwas mit der aktuellen Frage nicht. Ich starte neu.')
               .reprompt('Bereit?').getResponse();
    }

    // Slots robust auslesen
    const intent = h.requestEnvelope.request.intent || {};
    const slots  = intent.slots || {};
    let userAnswer = null;

    if (slots && slots.answerOption && slots.answerOption.value) {
      const raw = String(slots.answerOption.value).trim();
      const idx = parseInt(raw, 10) - 1; // Basis 10!
      if (!isNaN(idx) && question.options && question.options[idx]) {
        userAnswer = question.options[idx];
      }
    }
    if (!userAnswer && slots && slots.freeAnswer && slots.freeAnswer.value) {
      userAnswer = String(slots.freeAnswer.value).trim();
    }

    if (!userAnswer) {
      return rb.speak('Bitte nenne die Option als Zahl oder sprich die Antwort. Zum Beispiel: Antwort 1 oder Es ist Herbst.')
               .reprompt('Welche Option wählst du?').getResponse();
    }

    // Prüfen und Fortschritt aktualisieren
    const correct = isCorrect(userAnswer, question);
    if (correct) {
      const level = session.progress.currentDifficulty;
      const set = new Set(session.progress.correct[level]);
      set.add(question.id);
      session.progress.correct[level] = Array.from(set);
    }

    // Stufe ggf. wechseln
    session.progress.currentDifficulty = computeCurrentDifficulty(session.progress);

    // Persistenz (falls aktiv)
    try {
      await saveProgress(h, session.progress.storyId, session.progress);
    } catch (e) {
      console.log('saveProgress Warnung:', e && e.message ? e.message : e);
    }

    const feedback = correct ? 'Richtig.' : `Nicht ganz. Richtig wäre: ${question.answer}.`;

    // Nächste Frage ziehen oder sauber beenden
    const next = pickNextQuestion(session.progress);
    if (!next || next.status === 'finished') {
      return rb.speak(`${feedback} Du hast alle Stufen dieser Story abgeschlossen. Willst du eine andere Story wählen?`)
               .reprompt('Andere Story?').getResponse();
    }

    session.currentQuestionId = next.question.id;
    const nq = next.question;
    const speech = `${feedback} Weiter. Kategorie ${next.difficulty}. ${nq.question} `
                 + nq.options.map((opt, i) => `Option ${i + 1}: ${opt}.`).join(' ');

    return rb.speak(speech).reprompt('Welche Option wählst du?').getResponse();
  }
};



const CancelAndStopIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.CancelIntent'
                || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.StopIntent');
    },
    handle(handlerInput) {
        const speakOutput = 'Goodbye!';

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .getResponse();
    }
};
/* *
 * FallbackIntent triggers when a customer says something that doesn’t map to any intents in your skill
 * It must also be defined in the language model (if the locale supports it)
 * This handler can be safely added but will be ingnored in locales that do not support it yet 
 * */
const FallbackIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent';
    },
    handle(handlerInput) {
        const speakOutput = 'Sorry, I don\'t know about that. Please try again.';

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(speakOutput)
            .getResponse();
    }
};
/* *
 * SessionEndedRequest notifies that a session was ended. This handler will be triggered when a currently open 
 * session is closed for one of the following reasons: 1) The user says "exit" or "quit". 2) The user does not 
 * respond or says something that does not match an intent defined in your voice model. 3) An error occurs 
 * */
const SessionEndedRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
    },
    handle(handlerInput) {
        console.log(`~~~~ Session ended: ${JSON.stringify(handlerInput.requestEnvelope)}`);
        // Any cleanup logic goes here.
        return handlerInput.responseBuilder.getResponse(); // notice we send an empty response
    }
};
/* *
 * The intent reflector is used for interaction model testing and debugging.
 * It will simply repeat the intent the user said. You can create custom handlers for your intents 
 * by defining them above, then also adding them to the request handler chain below 
 * */
const IntentReflectorHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest';
    },
    handle(handlerInput) {
        const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);
        const speakOutput = `You just triggered ${intentName}`;

        return handlerInput.responseBuilder
            .speak(speakOutput)
            //.reprompt('add a reprompt if you want to keep the session open for the user to respond')
            .getResponse();
    }
};
/**
 * Generic error handling to capture any syntax or routing errors. If you receive an error
 * stating the request handler chain is not found, you have not implemented a handler for
 * the intent being invoked or included it in the skill builder below 
 * */
const ErrorHandler = {
    canHandle() {
        return true;
    },
    handle(handlerInput, error) {
        const speakOutput = 'Sorry, I had trouble doing what you asked. Please try again.';
        console.log(`~~~~ Error handled: ${JSON.stringify(error)}`);

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(speakOutput)
            .getResponse();
    }
};


// --- SkillBuilder robust aufsetzen (custom + optional Persistenz) ---
let builder = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    ChooseLearnTimeIntentHandler,
    ChooseTopicIntentHandler,
    TellStoryIntentHandler,
    AskQuestionsIntentHandler,
    AnswerCheckIntentHandler,
    GPTIntentHandler,
    HelpIntentHandler,
    CancelAndStopIntentHandler,
    FallbackIntentHandler,
    SessionEndedRequestHandler,
    IntentReflectorHandler
  )
  .addErrorHandlers(ErrorHandler)
  .withCustomUserAgent('sample/hello-world/v1.2');

if (persistenceAdapter) {
  builder = builder.withPersistenceAdapter(persistenceAdapter);
}

exports.handler = builder.lambda();
