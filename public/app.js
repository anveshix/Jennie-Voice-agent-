/* ============================================================================
   Jenni — browser logic
   Local workspace (PIN, drafts, tasks, notes) + voice input + AI chat proxy.

   Nothing here talks to an AI provider directly: chat and transcription go to
   /api/chat and /api/transcribe on the Node server, which holds the API key.
   ========================================================================= */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ state */
  const state = {
    unlocked: false,
    pinVerifier: '',
    pinSalt: '',
    pinCheckInProgress: false,
    enteredPin: '',
    language: 'hinglish',
    muted: false,
    isListening: false,
    wakeLoopActive: false,
    speaking: false,
    detectedTone: 'Calm & Focused',
    lastGeneratedMarkdown: '',
    driveFiles: [],
    selectedDriveFileId: null,
    tasks: [],
    learnedMemories: [],
    conversation: [],
    aiConfigured: false,
    transcriptionConfigured: false,
    aiModel: '',
    serverReachable: false,
    isResponding: false,
    requestController: null,
    transcriptionController: null,
    discardRecording: false,
    isTranscribing: false,
    isStartingRecording: false
  };

  const $ = (id) => document.getElementById(id);

  try {
    // Remove private sample data and the former plaintext PIN from earlier versions.
    ['jenni_owner_pin', 'jenni_rsi_memories_v8', 'jenni_tasks_v8', 'jenni_drive_catalog_v8']
      .forEach((key) => localStorage.removeItem(key));

    const storedSalt = localStorage.getItem('jenni_pin_salt_v1') || '';
    const storedVerifier = localStorage.getItem('jenni_pin_verifier_v1') || '';
    if (/^[0-9a-f]{32}$/.test(storedSalt) && /^[0-9a-f]{64}$/.test(storedVerifier)) {
      state.pinSalt = storedSalt;
      state.pinVerifier = storedVerifier;
    } else {
      localStorage.removeItem('jenni_pin_salt_v1');
      localStorage.removeItem('jenni_pin_verifier_v1');
    }

    const savedMemories = JSON.parse(localStorage.getItem('jenni_memories_v1') || '[]');
    if (Array.isArray(savedMemories)) state.learnedMemories = savedMemories;
    const savedTasks = JSON.parse(localStorage.getItem('jenni_tasks_v1') || '[]');
    if (Array.isArray(savedTasks)) state.tasks = savedTasks;
    const savedDrafts = JSON.parse(localStorage.getItem('jenni_local_drafts_v1') || '[]');
    if (Array.isArray(savedDrafts)) state.driveFiles = savedDrafts;
  } catch (e) { /* storage blocked — app still runs, just without persistence */ }

  function saveState() {
    try {
      localStorage.setItem('jenni_memories_v1', JSON.stringify(state.learnedMemories));
      localStorage.setItem('jenni_tasks_v1', JSON.stringify(state.tasks));
      localStorage.setItem('jenni_local_drafts_v1', JSON.stringify(state.driveFiles));
    } catch (e) { /* ignore quota / privacy mode */ }
  }

  /* ------------------------------------------------------------------ toast */
  let toastTimer = null;
  function showToast(msg) {
    const box = $('toastBox');
    if (!box) return;
    box.textContent = msg;
    box.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove('is-visible'), 3200);
  }

  /* -------------------------------------------------------------- AI status */
  const STATUS_BADGE = {
    ready: 'AI ready',
    working: 'Working…',
    setup: 'Setup required',
    offline: 'Server offline'
  };

  function setAIStatus(mode, message) {
    const pill = $('aiStatusPill');
    const label = $('aiServiceStatus');
    const badge = $('setupProviderBadge');
    if (pill) pill.setAttribute('data-mode', mode);
    if (label) label.textContent = message;
    if (badge) badge.textContent = STATUS_BADGE[mode] || STATUS_BADGE.offline;
    if (pill) pill.title = message;
  }

  async function refreshAIHealth() {
    try {
      const response = await fetch('/api/health', { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('AI server is unavailable.');
      const health = await response.json();
      state.serverReachable = true;
      state.aiConfigured = Boolean(health.configured);
      state.transcriptionConfigured = Boolean(health.transcriptionConfigured);
      state.aiModel = String(health.model || '');
      if (state.aiConfigured) {
        setAIStatus('ready', `AI ready · ${state.aiModel || 'provider'}`);
      } else {
        setAIStatus('setup', 'AI not configured — add a key in .env');
      }
      updateReadiness();
      return health;
    } catch (error) {
      state.serverReachable = false;
      updateReadiness();
      state.aiConfigured = false;
      state.transcriptionConfigured = false;
      setAIStatus('offline', 'Server offline — run npm start');
      return null;
    }
  }

  function restoreAIStatus() {
    if (!state.serverReachable) {
      setAIStatus('offline', 'Server offline — run npm start');
    } else if (!state.aiConfigured) {
      setAIStatus('setup', 'AI not configured — add a key in .env');
    } else {
      setAIStatus('ready', `AI ready · ${state.aiModel || 'provider'}`);
    }
  }

  /* ------------------------------------------------------------------- orb UI */
  function syncOrbState() {
    const orb = $('btnHeyJenniOrb');
    const stage = $('orbStage');
    if (orb) {
      orb.classList.toggle('is-listening', state.isListening);
      orb.classList.toggle('is-speaking', state.speaking);
    }
    if (stage) {
      stage.classList.toggle('is-listening', state.isListening);
      stage.classList.toggle('is-speaking', state.speaking);
    }
  }

  function setSubtitle(text) {
    const el = $('jenniSubtitle');
    if (el) el.textContent = text;
  }

  /* ------------------------------------------------------------- PIN handling */
  function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function createPinSalt() {
    if (!window.crypto || !window.crypto.getRandomValues) throw new Error('Secure random values are unavailable.');
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  }

  async function derivePinVerifier(pin, saltHex) {
    if (!window.crypto || !window.crypto.subtle) throw new Error('Secure browser crypto is unavailable.');
    const salt = new Uint8Array((saltHex.match(/.{2}/g) || []).map((byte) => parseInt(byte, 16)));
    const key = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = await window.crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
      key,
      256
    );
    return bytesToHex(new Uint8Array(bits));
  }

  function updatePinLockInstructions() {
    const instructions = $('pinLockInstructions');
    if (!instructions) return;
    instructions.textContent = state.pinVerifier
      ? 'Enter the 4-digit PIN set for this browser. This screen is a convenience, not a security boundary.'
      : 'First use: choose a 4-digit PIN for this browser. Later, enter that PIN to unlock. This screen is a convenience, not a security boundary.';
  }

  function updatePinDots() {
    document.querySelectorAll('#pinDotsRow span').forEach((dot, idx) => {
      dot.classList.toggle('is-filled', idx < state.enteredPin.length);
    });
  }

  function unlockWorkspace() {
    state.unlocked = true;
    state.enteredPin = '';
    updatePinDots();
    $('pinErrorMsg')?.classList.add('hidden');
    $('pinLockModal')?.classList.add('hidden');
    playChime(660, 880);
    speakHumble('Hello. Your local workspace is unlocked.');
  }

  async function verifyPinEntry() {
    if (state.pinCheckInProgress) return;
    const pin = state.enteredPin;
    state.enteredPin = '';
    updatePinDots();
    if (!/^\d{4}$/.test(pin)) return;

    state.pinCheckInProgress = true;
    const err = $('pinErrorMsg');
    try {
      if (!state.pinVerifier) {
        const salt = createPinSalt();
        const verifier = await derivePinVerifier(pin, salt);
        localStorage.setItem('jenni_pin_salt_v1', salt);
        localStorage.setItem('jenni_pin_verifier_v1', verifier);
        state.pinSalt = salt;
        state.pinVerifier = verifier;
        updatePinLockInstructions();
        unlockWorkspace();
        showToast('PIN set for this browser.');
        return;
      }

      const candidate = await derivePinVerifier(pin, state.pinSalt);
      if (candidate === state.pinVerifier) {
        unlockWorkspace();
      } else {
        err?.classList.remove('hidden');
        playChime(220, 180);
      }
    } catch (e) {
      showToast('PIN needs a secure browser context with local storage enabled.');
    } finally {
      state.pinCheckInProgress = false;
    }
  }

  /* ------------------------------------------------------------------ audio */
  let audioCtx = null;

  function playChime(f1 = 540, f2 = 760) {
    if (state.muted) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!audioCtx && AC) audioCtx = new AC();
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      const now = audioCtx.currentTime;
      osc.frequency.setValueAtTime(f1, now);
      osc.frequency.exponentialRampToValueAtTime(f2, now + 0.13);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.15);
    } catch (e) { /* audio is a nicety, never a blocker */ }
  }

  function analyzeVoiceToneFromTranscript(transcript, durationMs) {
    const words = transcript.trim().split(/\s+/).length;
    const wpm = durationMs > 400 ? Math.round((words / (durationMs / 1000)) * 60) : 135;
    const lower = transcript.toLowerCase();

    let tone = 'Calm & Focused';
    if (lower.includes('urgent') || lower.includes('fast') || lower.includes('jaldi') || lower.includes('तुरंत') || wpm > 175) {
      tone = 'Urgent & Executive';
    } else if (lower.includes('explain') || lower.includes('detail') || lower.includes('विस्तार') || wpm < 110) {
      tone = 'Reflective & Deep';
    } else {
      tone = 'Calm & Authoritative';
    }
    state.detectedTone = tone;
    const cadence = $('cadenceReadout');
    const pitch = $('pitchReadout');
    if (cadence) cadence.textContent = `${wpm} wpm`;
    if (pitch) pitch.textContent = tone.split(' ')[0];
  }

  /* -------------------------------------------------------------------- TTS */
  function speakHumble(text) {
    if (state.muted || !('speechSynthesis' in window)) return;
    try {
      if (recognition && state.isListening) {
        try { recognition.stop(); } catch (e) { /* already stopped */ }
      }
      window.speechSynthesis.cancel();

      const clean = text
        .replace(/[*#_`~>•↗]/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
      if (!clean) return;

      const utter = new SpeechSynthesisUtterance(clean);
      const voices = window.speechSynthesis.getVoices();
      const isDevanagari = /[\u0900-\u097F]/.test(clean);

      if (state.language === 'hi' || isDevanagari) {
        utter.lang = 'hi-IN';
        const v = voices.find((x) => x.lang.includes('hi'));
        if (v) utter.voice = v;
      } else {
        const v = voices.find((x) => x.lang === 'en-IN' || x.lang === 'hi-IN' || x.lang.includes('en'));
        utter.lang = v ? v.lang : 'en-IN';
        if (v) utter.voice = v;
      }

      utter.rate = state.detectedTone.includes('Urgent') ? 1.08 : 1.0;
      utter.pitch = 1.05;

      utter.onstart = () => {
        state.speaking = true;
        syncOrbState();
      };
      utter.onend = () => {
        state.speaking = false;
        syncOrbState();
        if (state.wakeLoopActive && state.unlocked) {
          setTimeout(() => startListeningSafely(), 400);
        }
      };
      utter.onerror = () => {
        state.speaking = false;
        syncOrbState();
      };

      window.speechSynthesis.speak(utter);
    } catch (e) { /* speech synthesis unavailable */ }
  }

  /* ------------------------------------------------------------- recognition */
  let recognition = null;
  let listenStartTime = 0;
  let mediaRecorder = null;
  let recordingStream = null;
  let recordingChunks = [];

  function initSpeechRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
      state.isListening = true;
      listenStartTime = Date.now();
      if ('speechSynthesis' in window && window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
      }
      playChime(520, 780);
      const lbl = $('orbActionLabel');
      const sub = $('orbSubLabel');
      if (lbl) lbl.textContent = 'Listening';
      if (sub) sub.textContent = 'Speak now';
      setSubtitle('Listening…');
      syncOrbState();
    };

    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      const input = $('botCommandInput');
      if (input && state.unlocked) {
        input.value = transcript;
        autoGrow(input);
      }

      if (event.results[event.results.length - 1].isFinal) {
        const finalClean = transcript.trim();
        const duration = Date.now() - listenStartTime;

        if (!state.unlocked) {
          if (!state.pinVerifier) {
            showToast('Set a PIN with the keypad before using voice unlock.');
            return;
          }
          const spokenPin = extractPinFromTranscript(finalClean);
          if (spokenPin) {
            state.enteredPin = spokenPin;
            updatePinDots();
            verifyPinEntry();
          } else {
            showToast('Voice PIN was not recognized. Please use the keypad.');
          }
          return;
        }

        if (state.wakeLoopActive && !/(?:\b(?:hey|hi)\s+jenni\b|\bhey\s+jarvis\b|\bjenni\b|हे\s+जेननी|जेननी)/i.test(finalClean)) {
          setSubtitle('Hands-free on — waiting for “Hey Jenni”…');
          return;
        }
        analyzeVoiceToneFromTranscript(finalClean, duration);
        handleUserCommand(finalClean);
      }
    };

    recognition.onerror = (event) => {
      stopListeningUI();
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        showToast('Allow microphone and speech recognition access in your browser.');
      } else if (event.error && event.error !== 'no-speech' && event.error !== 'aborted') {
        showToast('Voice recognition failed. You can still type your message.');
      }
    };

    recognition.onend = () => {
      stopListeningUI();
      if (state.wakeLoopActive && state.unlocked && !state.speaking && !state.isResponding) {
        setTimeout(() => {
          if (state.wakeLoopActive && state.unlocked && !state.speaking && !state.isListening && !state.isResponding) {
            startListeningSafely();
          }
        }, 450);
      }
    };
  }

  function extractPinFromTranscript(transcript) {
    const text = transcript.toLowerCase();
    const digits = text.match(/\d/g) || [];
    if (digits.length === 4) return digits.join('');

    const digitWords = {
      zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4',
      five: '5', six: '6', seven: '7', eight: '8', nine: '9'
    };
    const words = text.match(/\b(?:zero|oh|o|one|two|three|four|five|six|seven|eight|nine)\b/g) || [];
    const spokenDigits = words.map((word) => digitWords[word]).join('');
    return /^\d{4}$/.test(spokenDigits) ? spokenDigits : '';
  }

  function startListeningSafely() {
    if (!recognition) return;
    try {
      recognition.lang = state.language === 'en' ? 'en-IN' : 'hi-IN';
      recognition.start();
    } catch (e) { /* start() while already running throws — ignore */ }
  }

  async function toggleAudioRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      showToast('Microphone recording is not available here. Type your message or try a supported browser.');
      return;
    }
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }
    if (state.isStartingRecording) return;
    state.isStartingRecording = true;
    try {
      recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      recordingChunks = [];
      const preferredType = typeof MediaRecorder.isTypeSupported === 'function'
        ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((type) => MediaRecorder.isTypeSupported(type))
        : '';
      mediaRecorder = preferredType ? new MediaRecorder(recordingStream, { mimeType: preferredType }) : new MediaRecorder(recordingStream);
      mediaRecorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size) recordingChunks.push(event.data);
      });
      mediaRecorder.addEventListener('stop', () => {
        const blob = new Blob(recordingChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        recordingStream?.getTracks().forEach((track) => track.stop());
        recordingStream = null;
        state.isListening = false;
        stopListeningUI();
        if (state.discardRecording) {
          state.discardRecording = false;
          recordingChunks = [];
          return;
        }
        if (blob.size) transcribeRecording(blob);
        else showToast('No audio was captured. Please try again.');
      }, { once: true });
      mediaRecorder.start();
      listenStartTime = Date.now();
      state.isListening = true;
      const label = $('orbActionLabel');
      const sub = $('orbSubLabel');
      if (label) label.textContent = 'Recording';
      if (sub) sub.textContent = 'Tap to finish';
      setSubtitle('Recording… tap the microphone again when you have finished speaking.');
      syncOrbState();
    } catch (error) {
      recordingStream?.getTracks().forEach((track) => track.stop());
      recordingStream = null;
      state.isListening = false;
      stopListeningUI();
      showToast(error.name === 'NotAllowedError' ? 'Allow microphone access in your browser to use voice input.' : 'Could not start microphone recording. Check your browser permissions.');
    } finally {
      state.isStartingRecording = false;
    }
  }

  async function transcribeRecording(blob) {
    state.isTranscribing = true;
    const controller = new AbortController();
    state.transcriptionController = controller;
    setComposerBusy(true);
    setAIStatus('working', 'Transcribing your voice…');
    let handedOffToChat = false;
    try {
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm', Accept: 'application/json' },
        cache: 'no-store',
        body: blob,
        signal: controller.signal
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const serverMessage = payload?.error?.message;
        if (serverMessage) throw new Error(serverMessage);
        if (response.status === 404 || response.status === 405) throw new Error('The AI server is unavailable. Run npm start and open its local URL.');
        throw new Error(`Speech transcription failed (HTTP ${response.status}).`);
      }
      const transcript = String(payload?.text || '').trim();
      if (!transcript) throw new Error('No speech was recognized. Please try again or type your message.');
      const input = $('botCommandInput');
      if (input) {
        input.value = transcript;
        autoGrow(input);
      }
      analyzeVoiceToneFromTranscript(transcript, Date.now() - listenStartTime);
      state.isTranscribing = false;
      if (state.transcriptionController === controller) state.transcriptionController = null;
      setComposerBusy(false);
      restoreAIStatus();
      if (state.unlocked) {
        handedOffToChat = true;
        handleUserCommand(transcript);
      }
    } catch (error) {
      if (error.name !== 'AbortError' && state.unlocked) {
        showToast(error instanceof TypeError ? 'Could not reach the transcription server. Type your message or run npm start.' : error.message);
      }
    } finally {
      if (state.transcriptionController === controller) state.transcriptionController = null;
      state.isTranscribing = false;
      if (!handedOffToChat) {
        setComposerBusy(false);
        restoreAIStatus();
      }
    }
  }

  function stopAudioCapture() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return true;
    }
    return false;
  }

  function stopListeningUI() {
    state.isListening = false;
    const lbl = $('orbActionLabel');
    const sub = $('orbSubLabel');
    if (lbl) lbl.textContent = 'Hey Jenni';
    if (sub) sub.textContent = state.wakeLoopActive ? 'Hands-free on' : 'Tap or speak';
    if (!state.speaking && !state.isResponding) setSubtitle('Tap the microphone or type a message.');
    syncOrbState();
  }

  /* ------------------------------------------------------------- local drafts */
  function searchDriveCatalog(queryText) {
    const q = String(queryText || '').toLowerCase();
    const keywords = q
      .replace(/hey\s+jenni|jenni|jarvis|memory|search|find|in\s+my\s+google\s+drive|in\s+my\s+drive|drive|doc|docs|where\s+is|show\s+me|ढूँढो|खोजो/gi, ' ')
      .trim()
      .split(/\s+/)
      .filter((word) => word.length >= 2);

    if (keywords.length === 0) return state.driveFiles.slice(0, 6);

    return state.driveFiles
      .map((item) => {
        const hay = `${item.title || ''} ${item.snippet || ''} ${item.folderName || ''}`.toLowerCase();
        const score = keywords.reduce((total, word) => total + (hay.includes(word) ? 1 : 0), 0);
        return { item, score };
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((result) => result.item);
  }

  function selectDriveFileForEdit(fileId) {
    const found = state.driveFiles.find((file) => file.id === fileId);
    const badge = $('activeDocCategoryBadge');
    const link = $('activeDocExternalLink');
    const titleIn = $('activeDocTitleInput');
    const contentIn = $('activeDocContentArea');

    if (!found) {
      state.selectedDriveFileId = null;
      if (badge) badge.textContent = 'No draft selected';
      if (link) {
        link.removeAttribute('href');
        link.classList.add('hidden');
      }
      if (titleIn) titleIn.value = '';
      if (contentIn) contentIn.value = '';
      return;
    }

    state.selectedDriveFileId = found.id;
    if (badge) badge.textContent = 'Local draft · this browser';
    if (link) {
      link.removeAttribute('href');
      link.classList.add('hidden');
    }
    if (titleIn) titleIn.value = found.title || '';
    if (contentIn) contentIn.value = found.snippet || '';
  }

  function renderDriveStudioList() {
    const grid = $('driveFilesGrid');
    if (!grid) return;
    const q = ($('driveSearchInput')?.value || '').trim().toLowerCase();
    const cat = $('driveCategoryFilter')?.value || 'ALL';
    const filtered = state.driveFiles.filter((file) => {
      const matchCat = cat === 'ALL' || file.category === cat;
      const matchQ = !q || `${file.title || ''} ${file.snippet || ''}`.toLowerCase().includes(q);
      return matchCat && matchQ;
    });

    if (filtered.length === 0) {
      grid.innerHTML = state.driveFiles.length
        ? '<p class="prose">No drafts match this search.</p>'
        : '<p class="prose">No drafts yet. Write in the editor and choose <strong>Save draft</strong>.</p>';
    } else {
      grid.innerHTML = filtered.map((file) => {
        const isSelected = file.id === state.selectedDriveFileId;
        const preview = String(file.snippet || '').replace(/[#*`>]/g, '').slice(0, 90);
        return `
          <button type="button" data-select-id="${escapeHtml(file.id)}" class="card-row drive-select-btn" aria-current="${isSelected}">
            <span class="card-row__icon" aria-hidden="true"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" stroke-linejoin="round"/><path d="M13.5 3v5.5H19" stroke-linejoin="round"/></svg></span>
            <span style="min-width:0;flex:1">
              <span class="card-row__title">${escapeHtml(file.title || 'Untitled draft')}</span>
              <span class="card-row__meta">${escapeHtml(preview || 'Empty draft')}</span>
            </span>
          </button>`;
      }).join('');
    }

    grid.querySelectorAll('.drive-select-btn').forEach((button) => {
      button.addEventListener('click', () => {
        selectDriveFileForEdit(button.getAttribute('data-select-id'));
        renderDriveStudioList();
      });
    });

    const count = state.driveFiles.length;
    const label = $('nextEtaLabel');
    if (label) label.textContent = count ? `${count} draft${count === 1 ? '' : 's'} in this browser` : 'No drafts yet';
  }

  /* ---------------------------------------------------------------- assistant */
  function localAssistantReply(reply, speechText = reply) {
    appendMessage('jenni', reply);
    speakHumble(speechText);
  }

  async function showAssistantStatus() {
    const health = await refreshAIHealth();
    const aiLine = state.aiConfigured
      ? `AI chat: connected (${state.aiModel || 'configured model'})`
      : `AI chat: ${health ? 'not configured; add provider settings to .env and restart the server' : 'server unavailable; start with npm start'}`;
    const speechLine = recognition
      ? 'Voice input: browser speech recognition available'
      : (typeof MediaRecorder !== 'undefined' && navigator.mediaDevices?.getUserMedia
        ? `Voice input: tap-to-record ${state.transcriptionConfigured ? 'transcription endpoint configured' : 'requires AI setup'}`
        : 'Voice input: not available in this browser');
    const reply = [
      aiLine,
      speechLine,
      `Local drafts: ${state.driveFiles.length}`,
      `Local tasks: ${state.tasks.length}`,
      `Local PIN: ${state.pinVerifier ? 'configured' : 'setup required'} (convenience only)`,
      'Google Drive and external sending: not connected.'
    ].join('  \n');
    appendMessage('jenni', reply);
    speakHumble(`Jenni status. ${aiLine}. ${speechLine}.`);
  }

  function getLocalDraftSearchQuery(command) {
    return command
      .replace(/\b(?:hey\s+jenni|hi\s+jenni|jenni|jarvis|search|find|list|show|open|edit|editing|update|append|my|local|drafts?|documents?|docs?|in|this|browser|for|please|the|a|an|latest|first|drive|google|saved|save|where|are|is|should|i|folder|location|कहाँ|सेव|ढूँढो|खोजो)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function handleLocalCommand(coreCmd) {
    const lower = coreCmd.toLowerCase();

    if (lower === 'doctor' || lower === 'assistant status' || lower === 'status of jenni') {
      showAssistantStatus();
      return true;
    }

    if (lower.includes('where should i save') || lower.includes('where to save') || lower.includes('where are my local drafts') || lower.includes('where are my drafts') || lower.includes('local drafts saved') || lower.includes('folder map') || lower.includes('कहाँ सेव') || lower.includes('किस फोल्डर')) {
      localAssistantReply('Local drafts are saved in this browser only. No Google Drive folder is connected.');
      return true;
    }

    const asksForDrive = /\b(?:google drive|my drive|drive folder)\b/i.test(lower);
    if (asksForDrive && /\b(?:search|find|open|edit|save|upload|send|list)\b/i.test(lower)) {
      localAssistantReply('Google Drive is not connected, so I cannot search, edit, upload, or send Drive files. You can use the local draft workspace in this browser.');
      return true;
    }

    const asksForLocalDraft = /\b(?:local draft|local drafts|draft in this browser|drafts in this browser|my drafts)\b/i.test(lower);
    const draftAction = /\b(?:search|find|list|show|open|edit|update|append|latest|where|saved)\b/i.test(lower);
    if (asksForLocalDraft && draftAction) {
      const results = searchDriveCatalog(getLocalDraftSearchQuery(coreCmd)).slice(0, 5);
      if (!results.length) {
        localAssistantReply('No matching local drafts were found. Create or save a draft in the local workspace first.');
        return true;
      }
      const wantsEdit = /\b(?:open|edit|update|append)\b/i.test(lower);
      if (wantsEdit) {
        selectDriveFileForEdit(results[0].id);
        renderDriveStudioList();
        openDrawer('drawer-drive');
        const reply = `Opened the local draft “${results[0].title}” in the editor. Review your changes and choose Save draft; no remote document will be changed.`;
        localAssistantReply(reply, 'The local draft is open in the editor. Review and save locally when ready.');
      } else {
        const list = results.map((result) => `- ${result.title}: ${String(result.snippet || '').slice(0, 140)}`).join('\n');
        localAssistantReply(`Local draft search results\n\n${list}`, `Found ${results.length} local draft${results.length === 1 ? '' : 's'}.`);
      }
      return true;
    }

    if (lower.startsWith('remember') || lower.startsWith('learn') || lower.startsWith('याद रखो')) {
      const note = coreCmd.replace(/^(remember\s+that|remember|learn\s+that|learn|याद\s+रखो\s+कि|याद\s+रखो)\s*/i, '').trim();
      if (note) {
        state.learnedMemories.unshift(note);
        saveState();
        renderMemories();
        localAssistantReply('Saved that note in this browser. It is not sent to the AI provider.');
      } else {
        localAssistantReply('What would you like me to remember in this browser?');
      }
      return true;
    }

    const asksForTaskSummary = /\b(?:task list|my tasks|local tasks|what tasks|tasks? (?:status|summary|due)|what is done|what's done|what is completed|what remains|what is remaining|what is left|to do list)\b/i.test(lower)
      || lower.includes('what remained to do') || lower.includes('क्या पूरा') || lower.includes('क्या बाकी');
    if (asksForTaskSummary) {
      const groups = [
        ['Completed', state.tasks.filter((task) => task.status === 'COMPLETED')],
        ['In progress', state.tasks.filter((task) => task.status === 'IN PROGRESS')],
        ['Remaining', state.tasks.filter((task) => task.status === 'REMAINED')]
      ];
      const report = groups.map(([label, tasks]) => `${label} (${tasks.length}): ${tasks.length ? tasks.map((task) => `${task.title} — ${task.when}`).join('; ') : 'none'}`).join('\n');
      const reply = state.tasks.length ? `Local task list\n\n${report}` : 'There are no local tasks yet. Add a task in the Tasks panel and I can summarize it.';
      localAssistantReply(reply, state.tasks.length ? `You have ${state.tasks.length} local tasks.` : 'There are no local tasks yet.');
      return true;
    }

    if (lower.includes('fake mark') || lower.includes('forge ') || lower.includes('leak student') || lower.includes('bypass pin') || lower.includes('फर्जी')) {
      localAssistantReply('Safety check: I cannot help falsify records, expose private information, or bypass access controls. I can help with a legitimate, privacy-respecting alternative.');
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ hero visual */
  function startAmbientMotion() {
    const stage = $('orbStage');
    if (!stage) return;
    const layers = [
      { el: document.querySelector('.aurora--mint'), x: 14, y: 10 },
      { el: document.querySelector('.aurora--violet'), x: -12, y: 14 },
      { el: document.querySelector('.aurora--sky'), x: 10, y: -12 }
    ].filter((layer) => layer.el);

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !layers.length) return;

    let animating = false;
    const run = () => {
      if (animating) return;
      animating = true;
      window.addEventListener('mousemove', (event) => {
        const nx = event.clientX / window.innerWidth - 0.5;
        const ny = event.clientY / window.innerHeight - 0.5;
        layers.forEach(({ el, x, y }, index) => {
          const depth = (index + 1) * 0.5;
          el.style.transform = `translate3d(${nx * x * depth}px, ${ny * y * depth}px, 0)`;
        });
        stage.style.transform = `translate3d(${nx * -6}px, ${ny * -5}px, 0)`;
      }, { passive: true });
    };
    run();
  }


  /* ------------------------------------------------------------- API Room */

  function providersApi() {
    return window.JENNI_PROVIDERS || null;
  }

  function setRoomResult(text, kind) {
    const el = $('roomResult');
    if (!el) return;
    el.textContent = text || '';
    el.className = `room-result${kind ? ` is-${kind}` : ''}`;
  }

  function setRoomField(id, value) {
    const el = $(id);
    if (el && value !== undefined && value !== null) el.value = value;
  }

  function pickPreset(name) {
    const api = providersApi();
    if (!api) return;
    const preset = api.PRESETS[name];
    if (!preset) return;
    document.querySelectorAll('#presetRow .preset').forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-provider') === name ? 'true' : 'false');
    });
    setRoomField('roomBaseUrl', preset.baseUrl);
    setRoomField('roomModel', preset.model);
    setRoomField('roomTranscriptionModel', preset.transcriptionModel);
    const note = $('presetNote');
    if (note) {
      note.textContent = preset.note + (preset.keyUrl ? ` Key: ${preset.keyUrl}` : '');
    }
    const key = $('roomApiKey');
    if (key) key.placeholder = name === 'ollama' ? 'not needed for a local model' : 'paste your key here';
    state.roomPreset = name;
  }

  function fillRoomStatus(info) {
    const set = (id, text, kind) => {
      const el = $(id);
      if (!el) return;
      el.textContent = text;
      el.className = `room-status__value${kind ? ` is-${kind}` : ''}${id === 'roomModelStatus' ? ' mono' : ''}`;
    };
    if (!info) {
      set('roomProvider', 'Server not reachable', 'off');
      set('roomModelStatus', '—', 'off');
      set('roomTranscription', '—', 'off');
      set('roomKeySource', '—', 'off');
      return;
    }
    const api = providersApi();
    const preset = api && api.PRESETS[info.provider];
    set('roomProvider', preset ? preset.label : (info.provider || 'custom'), info.configured ? 'ok' : 'warn');
    set('roomModelStatus', info.model || '—', info.configured ? 'ok' : 'warn');
    set('roomTranscription', info.transcriptionConfigured
      ? `on · ${info.transcriptionModel}`
      : (info.isLocal ? 'local model — off' : 'off (browser speech only)'), info.transcriptionConfigured ? 'ok' : 'warn');
    set('roomKeySource', info.keySet
      ? (info.source === 'room' ? 'API Room (saved here)' : '.env file')
      : (info.isLocal ? 'not needed (local)' : 'missing'), info.keySet || info.isLocal ? 'ok' : 'off');

    const badge = $('setupProviderBadge');
    if (badge) badge.textContent = info.configured ? 'Configured' : 'Setup required';
  }

  function syncPresetRow(provider) {
    const name = providersApi() && providersApi().PRESETS[provider] ? provider : 'custom';
    state.roomPreset = name;
    document.querySelectorAll('#presetRow .preset').forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-provider') === name ? 'true' : 'false');
    });
    const preset = providersApi() ? providersApi().PRESETS[name] : null;
    const note = $('presetNote');
    if (preset && note) {
      note.textContent = `${preset.label}: ${preset.note}${preset.keyUrl ? ` · Key: ${preset.keyUrl}` : ''}`;
    }
  }

  /** Fill the form with the effective settings; the key is never sent back. */
  function hydrateRoomForm(info) {
    if (!info) return;
    const base = $('roomBaseUrl');
    const model = $('roomModel');
    const voice = $('roomTranscriptionModel');
    if (base) base.value = info.baseUrl || '';
    if (model) model.value = info.model || '';
    if (voice) voice.value = info.transcriptionModel || '';
    const key = $('roomApiKey');
    if (key) {
      key.value = '';
      key.placeholder = info.keySet
        ? 'saved — leave empty to keep it'
        : (info.isLocal ? 'not needed for a local model' : 'paste your key here');
    }
  }

  async function loadRoomSettings(quiet) {
    try {
      const response = await fetch('/api/settings', { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('settings unavailable');
      const info = await response.json();
      state.roomInfo = info;
      fillRoomStatus(info);
      syncPresetRow(info.provider);
      hydrateRoomForm(info);
      return info;
    } catch (error) {
      fillRoomStatus(null);
      if (!quiet) setRoomResult('Server se settings nahi mili. `npm start` chal raha hai?', 'error');
      return null;
    }
  }

  async function saveRoomSettings() {
    const api = providersApi();
    if (!api) { setRoomResult('Provider list load nahi hui — page refresh karo.', 'error'); return; }
    const payload = {
      baseUrl: $('roomBaseUrl')?.value || '',
      model: $('roomModel')?.value || '',
      transcriptionModel: $('roomTranscriptionModel')?.value || '',
      apiKey: $('roomApiKey')?.value || '',
      keepKey: !($('roomApiKey')?.value || ''),
      provider: state.roomPreset || 'custom'
    };

    const check = api.validateSettings(payload, { keepKey: payload.keepKey && Boolean(state.roomInfo && state.roomInfo.keySet) });
    if (!check.valid) {
      setRoomResult(check.errors[0], 'error');
      return;
    }

    setRoomResult('Saving…', 'busy');
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload)
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error?.message || `Save failed (HTTP ${response.status}).`);
      }
      const key = $('roomApiKey');
      if (key) key.value = '';
      setRoomResult('Saved. Ab chat aur voice dono is provider se chalenge.', 'ok');
      ['roomBaseUrl', 'roomModel', 'roomTranscriptionModel'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
      await loadRoomSettings(true);
      await refreshAIHealth();
      updateReadiness();
      showToast('Provider settings saved.');
    } catch (error) {
      setRoomResult(error.message, 'error');
    }
  }

  async function testRoomConnection() {
    setRoomResult('Testing the provider…', 'busy');
    try {
      const response = await fetch('/api/settings/test', { method: 'POST', headers: { Accept: 'application/json' } });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message || `Test failed (HTTP ${response.status}).`);
      if (body.ok) {
        const voice = body.transcriptionConfigured ? 'voice transcription ready' : 'voice transcription off (browser speech still works)';
        setRoomResult(`Working — ${body.model} replied in ${body.ms} ms; ${voice}.`, 'ok');
      } else {
        setRoomResult(`Failed: ${body.message}`, 'error');
      }
    } catch (error) {
      setRoomResult(error.message, 'error');
    }
  }

  async function clearRoomSettings() {
    setRoomResult('Removing…', 'busy');
    try {
      const response = await fetch('/api/settings', { method: 'DELETE', headers: { Accept: 'application/json' } });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message || 'Could not remove the saved key.');
      setRoomResult(body.cleared ? 'Saved key hata di. .env wali settings (agar hai) ab chalegi.' : 'Koi saved key nahi thi.', 'ok');
      await loadRoomSettings(true);
      await refreshAIHealth();
      updateReadiness();
    } catch (error) {
      setRoomResult(error.message, 'error');
    }
  }

  function setCheck(name, stateName, text) {
    const li = document.querySelector(`#readinessList li[data-check="${name}"]`);
    if (!li) return;
    li.setAttribute('data-state', stateName);
    const t = li.querySelector('.check-text');
    if (t && text) t.textContent = text;
  }

  function updateReadiness() {
    const secure = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    setCheck('secure', secure ? 'ok' : 'off',
      secure ? 'Secure context (mic allowed)' : 'Not secure — mic needs https or localhost');

    const mic = Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    setCheck('mic', mic ? 'ok' : 'off', mic ? 'Microphone API available' : 'No microphone API in this browser');

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    setCheck('speech', SR ? 'ok' : 'warn', SR ? 'Browser speech recognition available' : 'Not in this browser — tap-to-record fallback');

    const tts = 'speechSynthesis' in window;
    setCheck('tts', tts ? 'ok' : 'warn', tts ? 'Spoken replies available' : 'No speech synthesis');

    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    setCheck('pwa', standalone ? 'ok' : 'warn', standalone ? 'Running as an installed app' : 'Browser tab — install available from the menu');

    setCheck('server', state.serverReachable ? 'ok' : 'off', state.serverReachable ? 'Server reachable' : 'Server not reachable — run npm start');
  }

  function bindRoomEvents() {
    document.querySelectorAll('#presetRow .preset').forEach((btn) => {
      btn.addEventListener('click', () => pickPreset(btn.getAttribute('data-provider')));
    });

    $('roomForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      saveRoomSettings();
    });

    $('btnTestRoom')?.addEventListener('click', testRoomConnection);
    $('btnClearRoom')?.addEventListener('click', clearRoomSettings);

    $('btnToggleKey')?.addEventListener('click', () => {
      const input = $('roomApiKey');
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      $('btnToggleKey').setAttribute('aria-label', show ? 'Hide the key' : 'Show the key');
    });

    // open the room straight from the status pill too
    $('aiStatusPill')?.addEventListener('click', () => {
      openDrawer('drawer-ai-setup');
      loadRoomSettings(true);
      updateReadiness();
    });
  }

  function setComposerBusy(busy) {
    const input = $('botCommandInput');
    const button = $('botSendButton');
    const form = $('botInputForm');
    if (input) input.disabled = busy;
    if (button) {
      button.disabled = busy;
      button.textContent = busy ? '···' : '➤';
    }
    if (form) form.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  async function askAssistant(userText) {
    const requestMessages = [...state.conversation, { role: 'user', content: userText }].slice(-12);
    state.isResponding = true;
    setComposerBusy(true);
    setAIStatus('working', 'Jenni is thinking…');
    const controller = new AbortController();
    state.requestController = controller;
    const pending = appendMessage('jenni', '', { pending: true });

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ messages: requestMessages }),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const serverMessage = payload?.error?.message;
        if (serverMessage) throw new Error(serverMessage);
        if (response.status === 404 || response.status === 405) {
          throw new Error('The AI server route is not available on this page. Run npm start and open the local server URL.');
        }
        throw new Error(`AI request failed (HTTP ${response.status}).`);
      }
      const reply = String(payload?.reply || '').trim();
      if (!reply) throw new Error('The AI provider returned an empty reply. Please try again.');
      if (!state.unlocked) return;
      state.conversation = [...requestMessages, { role: 'assistant', content: reply }].slice(-20);
      state.lastGeneratedMarkdown = reply;
      if (pending) pending.remove();
      appendMessage('jenni', reply, { saveAsDraft: true });
      speakHumble(reply);
    } catch (error) {
      if (pending) pending.remove();
      if (!state.unlocked || error.name === 'AbortError') return;
      const message = error instanceof TypeError
        ? 'I could not reach the AI server. Run npm start and open the server URL, then try again.'
        : (error.message || 'The AI request failed. Please try again.');
      const reply = `I couldn’t get an AI response. ${message}`;
      appendMessage('jenni', reply);
      speakHumble(reply);
    } finally {
      if (state.requestController === controller) state.requestController = null;
      state.isResponding = false;
      setComposerBusy(false);
      restoreAIStatus();
    }
  }

  function handleUserCommand(rawText) {
    if (!state.unlocked) {
      showToast('Please unlock Jenni with the PIN set for this browser.');
      return;
    }
    if (state.isResponding || state.isTranscribing) {
      showToast('Jenni is still preparing a reply. Please wait.');
      return;
    }
    const query = String(rawText || '').trim();
    if (!query) return;

    appendMessage('user', query);
    const input = $('botCommandInput');
    if (input) {
      input.value = '';
      autoGrow(input);
    }

    const coreCmd = query.replace(/^(hey\s+jenni|hi\s+jenni|jenni|hey\s+jarvis|हे\s+जेननी|जेननी)[,\s!।]*/i, '').trim();
    if (!coreCmd) {
      askAssistant(query);
      return;
    }
    if (handleLocalCommand(coreCmd)) return;
    askAssistant(coreCmd);
  }

  /* ------------------------------------------------------------------ render */
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatMd(text) {
    const safe = escapeHtml(text).replace(/\r/g, '');
    // a line that ends in ":" usually introduces its own detail lines — keep those together
    const blocks = safe.split(/\n{2,}/);
    return blocks.map((block) => {
      const lines = block.split('\n').filter((line, index, all) => !(line === '' && index === all.length - 1));
      if (lines.length && lines.every((line) => /^\s*[-*•]\s+/.test(line))) {
        const items = lines.map((line) => `<li>${inlineMd(line.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('');
        return `<ul>${items}</ul>`;
      }
      if (lines.length > 1 && /[:：]\s*$/.test(lines[0])) {
        const [head, ...rest] = lines;
        const tail = rest.every((line) => /^\s*[-*•]\s+/.test(line))
          ? `<ul>${rest.map((line) => `<li>${inlineMd(line.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('')}</ul>`
          : rest.map((line) => `<span class="line">${inlineMd(line)}</span>`).join('');
        return `<p>${inlineMd(head)}</p>${tail}`;
      }
      return `<p>${lines.map(inlineMd).join('<br>')}</p>`;
    }).join('');
  }

  function inlineMd(text) {
    return text
      .replace(/^###\s+(.*)$/, '<h4>$1</h4>')
      .replace(/^##\s+(.*)$/, '<h4>$1</h4>')
      .replace(/^#\s+(.*)$/, '<h4>$1</h4>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1 ↗</a>');
  }

  function appendMessage(sender, markdownText, options = {}) {
    const stream = $('botChatStream');
    if (!stream) return null;
    const div = document.createElement('div');
    div.className = `msg msg--${sender}`;

    if (sender === 'user') {
      div.innerHTML = `
        <div class="bubble">
          <span class="bubble__meta">You · ${escapeHtml(state.detectedTone)}</span>
          <div class="bubble__body">${escapeHtml(markdownText)}</div>
        </div>`;
    } else {
      const body = options.pending
        ? '<span class="typing" aria-label="Jenni is typing"><i></i><i></i><i></i></span>'
        : formatMd(markdownText);
      div.innerHTML = `
        <span class="msg__avatar" aria-hidden="true"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 4.5l1.7 4.6 4.6 1.7-4.6 1.7L12 17.1l-1.7-4.6L5.7 10.8l4.6-1.7z" stroke-linejoin="round"/></svg></span>
        <div class="bubble">
          <span class="bubble__meta">Jenni</span>
          <div class="bubble__body">${body}</div>
        </div>`;
      if (options.saveAsDraft && !options.pending) {
        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.className = 'bubble__action';
        saveButton.textContent = 'Save as local draft';
        saveButton.addEventListener('click', () => saveAIResponseAsDraft(markdownText, saveButton));
        div.querySelector('.bubble').appendChild(saveButton);
      }
    }

    stream.appendChild(div);
    stream.scrollTop = stream.scrollHeight;
    return div;
  }

  function saveAIResponseAsDraft(markdownText, button) {
    const content = String(markdownText || '').trim();
    if (!content) return;
    const firstLine = content.replace(/^#+\s*/m, '').replace(/[*_`]/g, '').split(/[\n.!?]/)[0].trim();
    const title = `AI: ${(firstLine || 'Saved response').slice(0, 58)}`;
    const draft = {
      id: `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      type: 'DOC',
      category: 'LOCAL',
      folderName: 'This browser',
      snippet: content
    };
    state.driveFiles.unshift(draft);
    state.selectedDriveFileId = draft.id;
    state.lastGeneratedMarkdown = `# ${title}\n\n${content}`;
    saveState();
    selectDriveFileForEdit(draft.id);
    renderDriveStudioList();
    if (button) {
      button.disabled = true;
      button.textContent = 'Saved locally ✓';
    }
    showToast('Saved in this browser only.');
  }

  function renderTasks() {
    const done = state.tasks.filter((task) => task.status === 'COMPLETED').length;
    const inProgress = state.tasks.filter((task) => task.status === 'IN PROGRESS').length;
    const remaining = state.tasks.filter((task) => task.status === 'REMAINED').length;

    if ($('countDone')) $('countDone').textContent = String(done);
    if ($('countProgress')) $('countProgress').textContent = String(inProgress);
    if ($('countRemained')) $('countRemained').textContent = String(remaining);

    const container = $('taskListContainer');
    if (!container) return;
    if (state.tasks.length === 0) {
      container.innerHTML = '<p class="prose">No tasks yet. Add one above.</p>';
      return;
    }

    container.innerHTML = state.tasks.map((task, index) => {
      const tone = task.status === 'COMPLETED' ? 'done' : (task.status === 'IN PROGRESS' ? 'progress' : 'remained');
      const label = task.status === 'COMPLETED' ? 'Done' : (task.status === 'IN PROGRESS' ? 'Doing' : 'Left');
      const chevron = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="width:11px;height:11px"><path d="m9 6 6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      return `
        <div class="task">
          <div style="min-width:0">
            <div class="task__title">${escapeHtml(task.title)}</div>
            <div class="task__when">${escapeHtml(task.when || 'No due date')}</div>
          </div>
          <button type="button" data-idx="${index}" class="badge badge--${tone} task-cycle-btn" title="Move to the next status">${label}${chevron}</button>
        </div>`;
    }).join('');

    container.querySelectorAll('.task-cycle-btn').forEach((button) => {
      button.addEventListener('click', () => {
        const index = parseInt(button.getAttribute('data-idx'), 10);
        const order = ['REMAINED', 'IN PROGRESS', 'COMPLETED'];
        const next = order[(order.indexOf(state.tasks[index].status) + 1) % order.length];
        state.tasks[index].status = next;
        if (next === 'COMPLETED') state.tasks[index].when = 'Completed';
        saveState();
        renderTasks();
      });
    });
  }

  function renderMemories() {
    const countEl = $('rsiMemoryReadout');
    if (countEl) countEl.textContent = `Notes ${state.learnedMemories.length}`;
    const list = $('memoryListContainer');
    if (!list) return;
    if (state.learnedMemories.length === 0) {
      list.innerHTML = '<p class="prose">No notes yet.</p>';
      return;
    }
    list.innerHTML = state.learnedMemories.map((memory, index) => `
      <div class="note-item">
        <span><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M9.5 4.5A3 3 0 0 0 6.6 8 3 3 0 0 0 5 13.4 3 3 0 0 0 8 18a2.6 2.6 0 0 0 4 .3V5.8a2 2 0 0 0-2.5-1.3Z" stroke-linejoin="round"/><path d="M14.5 4.5A3 3 0 0 1 17.4 8 3 3 0 0 1 19 13.4 3 3 0 0 1 16 18a2.6 2.6 0 0 1-4 .3" stroke-linejoin="round"/></svg> ${escapeHtml(memory)}</span>
        <span>#${index + 1}</span>
      </div>`).join('');
  }

  /* ---------------------------------------------------------------- drawers */
  function closeDrawers() {
    document.querySelectorAll('.drawer-panel').forEach((panel) => panel.classList.remove('is-open'));
    document.querySelectorAll('.drawer-toggle-btn').forEach((btn) => btn.setAttribute('aria-expanded', 'false'));
  }

  function openDrawer(id) {
    const panel = $(id);
    if (!panel) return;
    const alreadyOpen = panel.classList.contains('is-open');
    closeDrawers();
    if (!alreadyOpen) {
      panel.classList.add('is-open');
      document.querySelectorAll(`.drawer-toggle-btn[data-drawer="${id}"]`).forEach((btn) => btn.setAttribute('aria-expanded', 'true'));
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  /* ---------------------------------------------------------------- composer */
  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 130)}px`;
  }

  /* --------------------------------------------------------------- bindings */
  function bindEvents() {
    document.querySelectorAll('.pin-key').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.enteredPin.length < 4) {
          state.enteredPin += btn.getAttribute('data-digit');
          updatePinDots();
          $('pinErrorMsg')?.classList.add('hidden');
          if (state.enteredPin.length === 4) setTimeout(verifyPinEntry, 120);
        }
      });
    });

    $('btnPinClear')?.addEventListener('click', () => {
      state.enteredPin = '';
      updatePinDots();
    });

    $('btnVoicePinUnlock')?.addEventListener('click', () => {
      if (!state.pinVerifier) {
        showToast('Set a custom PIN with the keypad before voice unlock.');
        return;
      }
      if (recognition) {
        startListeningSafely();
        showToast('Speak the PIN you set for this browser.');
      } else {
        showToast('Voice recognition is not available here. Use the keypad.');
      }
    });

    $('btnLockNow')?.addEventListener('click', () => {
      state.unlocked = false;
      state.wakeLoopActive = false;
      state.conversation = [];
      state.requestController?.abort();
      state.transcriptionController?.abort();
      state.discardRecording = Boolean(mediaRecorder && mediaRecorder.state === 'recording');
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      if (recognition && state.isListening) {
        try { recognition.stop(); } catch (e) { /* ignore */ }
      }
      stopAudioCapture();
      recordingStream?.getTracks().forEach((track) => track.stop());
      recordingStream = null;
      $('botChatStream')?.replaceChildren();
      $('pinLockModal')?.classList.remove('hidden');
      updateWakeButton();
      showToast('Workspace locked. This tab’s chat history was cleared.');
    });

    $('btnChangePin')?.addEventListener('click', () => $('changePinModal')?.classList.remove('hidden'));
    $('btnCancelPinChange')?.addEventListener('click', () => $('changePinModal')?.classList.add('hidden'));

    $('btnSavePinChange')?.addEventListener('click', async () => {
      const input = $('newPinInput');
      const val = input.value.trim();
      if (!/^\d{4}$/.test(val)) {
        showToast('Please enter exactly 4 digits.');
        return;
      }
      try {
        const salt = createPinSalt();
        const verifier = await derivePinVerifier(val, salt);
        localStorage.setItem('jenni_pin_salt_v1', salt);
        localStorage.setItem('jenni_pin_verifier_v1', verifier);
        state.pinSalt = salt;
        state.pinVerifier = verifier;
        input.value = '';
        $('changePinModal')?.classList.add('hidden');
        updatePinLockInstructions();
        showToast('PIN updated for this browser.');
      } catch (e) {
        showToast('PIN update needs a secure browser context with local storage.');
      }
    });

    $('btnHeyJenniOrb')?.addEventListener('click', async () => {
      if (state.isResponding || state.isTranscribing) {
        showToast('Wait for Jenni to finish the current response.');
        return;
      }
      if (recognition) {
        if (state.isListening) {
          try { recognition.stop(); } catch (e) { /* ignore */ }
        } else {
          if ('speechSynthesis' in window) window.speechSynthesis.cancel();
          startListeningSafely();
        }
      } else {
        await toggleAudioRecording();
      }
    });

    $('btnAssistantStatus')?.addEventListener('click', showAssistantStatus);

    $('btnToggleWakeWord')?.addEventListener('click', () => {
      if (!recognition) {
        showToast('Hands-free wake listening is not supported here. Tap the microphone to speak instead.');
        return;
      }
      state.wakeLoopActive = !state.wakeLoopActive;
      updateWakeButton();
      if (state.wakeLoopActive) {
        speakHumble('Hands-free mode is active. Say Hey Jenni to begin.');
        setTimeout(() => startListeningSafely(), 1800);
      } else if (state.isListening) {
        try { recognition.stop(); } catch (e) { /* ignore */ }
        stopListeningUI();
      }
    });

    $('btnStopVoice')?.addEventListener('click', () => {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      if (recognition && state.isListening) {
        try { recognition.stop(); } catch (e) { /* ignore */ }
      }
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        state.discardRecording = true;
        stopAudioCapture();
      }
      state.wakeLoopActive = false;
      updateWakeButton();
      state.speaking = false;
      syncOrbState();
      setSubtitle('Stopped.');
    });

    document.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.language = btn.getAttribute('data-lang');
        document.querySelectorAll('.lang-btn').forEach((b) => b.setAttribute('aria-pressed', 'false'));
        btn.setAttribute('aria-pressed', 'true');
        showToast('Language: ' + state.language.toUpperCase());
      });
    });

    $('btnToggleMute')?.addEventListener('click', () => {
      state.muted = !state.muted;
      if (state.muted && 'speechSynthesis' in window) window.speechSynthesis.cancel();
      const icon = $('muteIcon');
      if (icon) {
        icon.innerHTML = state.muted
          ? '<path d="M4 9.5h3.2L12 5.5v13L7.2 14.5H4z" stroke-linejoin="round"/><path d="m16.5 9.5 4 5m0-5-4 5" stroke-linecap="round"/>'
          : '<path d="M4 9.5h3.2L12 5.5v13L7.2 14.5H4z" stroke-linejoin="round"/><path d="M16 9a4.2 4.2 0 0 1 0 6M18.6 6.6a8 8 0 0 1 0 10.8" stroke-linecap="round"/>';
      }
      showToast(state.muted ? 'Spoken replies muted.' : 'Spoken replies on.');
    });

    document.querySelectorAll('.status-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        handleUserCommand('Hey Jenni, what is done, what remained to do, and when is it to be done?');
      });
    });


    document.querySelectorAll('.quick-chip').forEach((chip) => {
      chip.addEventListener('click', () => handleUserCommand(chip.getAttribute('data-quick')));
    });

    $('botInputForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('botCommandInput');
      if (input && input.value.trim()) handleUserCommand(input.value.trim());
    });

    $('botCommandInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        $('botInputForm')?.requestSubmit();
      }
    });

    $('botCommandInput')?.addEventListener('input', (e) => autoGrow(e.target));

    document.querySelectorAll('.drawer-toggle-btn').forEach((btn) => {
      btn.addEventListener('click', () => openDrawer(btn.getAttribute('data-drawer')));
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      closeDrawers();
      $('changePinModal')?.classList.add('hidden');
    });

    $('driveSearchInput')?.addEventListener('input', renderDriveStudioList);
    $('driveCategoryFilter')?.addEventListener('change', renderDriveStudioList);

    $('btnSaveDocEdit')?.addEventListener('click', () => {
      const title = $('activeDocTitleInput').value.trim() || 'Untitled draft';
      const content = $('activeDocContentArea').value.trim();
      let draft = state.driveFiles.find((file) => file.id === state.selectedDriveFileId);

      if (draft) {
        draft.title = title;
        draft.snippet = content;
      } else {
        draft = {
          id: `draft_${Date.now()}`,
          title,
          type: 'DOC',
          category: 'LOCAL',
          folderName: 'This browser',
          snippet: content
        };
        state.driveFiles.unshift(draft);
        state.selectedDriveFileId = draft.id;
      }

      state.lastGeneratedMarkdown = `# ${title}\n\n${content}`;
      saveState();
      selectDriveFileForEdit(draft.id);
      renderDriveStudioList();
      showToast('Saved in this browser only.');
      appendMessage('jenni', `Saved “${title}” as a local draft. It has not been sent to Google Drive or any external service.`);
      speakHumble('Draft saved in this browser only. Nothing was sent externally.');
    });

    $('btnSpeakActiveDoc')?.addEventListener('click', () => {
      const titleVal = $('activeDocTitleInput').value.trim();
      const contentVal = $('activeDocContentArea').value.trim();
      speakHumble(`Reading ${titleVal}. ${contentVal}`);
    });

    $('btnAddNewTask')?.addEventListener('click', () => {
      const titleEl = $('newTaskTitle');
      const whenEl = $('newTaskWhen');
      if (!titleEl || !titleEl.value.trim()) return;
      state.tasks.unshift({
        id: `T-${state.tasks.length + 1}`,
        title: titleEl.value.trim(),
        when: (whenEl && whenEl.value.trim()) ? whenEl.value.trim() : 'No due date set',
        status: 'REMAINED'
      });
      titleEl.value = '';
      if (whenEl) whenEl.value = '';
      saveState();
      renderTasks();
      showToast('Task added to this browser.');
    });

    $('newTaskTitle')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('btnAddNewTask')?.click();
    });

    $('btnAddMemory')?.addEventListener('click', () => {
      const el = $('newMemoryInput');
      if (!el || !el.value.trim()) return;
      state.learnedMemories.unshift(el.value.trim());
      el.value = '';
      saveState();
      renderMemories();
      showToast('Note saved in this browser.');
    });

    $('newMemoryInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('btnAddMemory')?.click();
    });

    $('btnDownloadLastDoc')?.addEventListener('click', () => {
      const content = state.lastGeneratedMarkdown || $('activeDocContentArea').value || '# Jenni draft';
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Jenni_Local_Draft.md';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Downloaded .md file.');
    });
  }

  function updateWakeButton() {
    const btn = $('btnToggleWakeWord');
    if (btn) btn.textContent = `Hands-free: ${state.wakeLoopActive ? 'on' : 'off'}`;
  }

  /* --------------------------------------------------------------- bootstrap */
  window.addEventListener('load', () => {
    initSpeechRecognition();
    renderTasks();
    renderMemories();
    selectDriveFileForEdit(state.selectedDriveFileId);
    renderDriveStudioList();
    bindEvents();
    updateWakeButton();

    updatePinLockInstructions();
    startAmbientMotion();
    bindRoomEvents();
    updateReadiness();
    loadRoomSettings(true);
    appendMessage('jenni', 'Hi! Ask me anything by typing or tapping the microphone. I use the AI provider configured on this server; drafts, tasks and notes stay in this browser.');
    state.lastGeneratedMarkdown = '';
    refreshAIHealth();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
