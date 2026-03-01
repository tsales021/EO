const express = require('express');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DEFAULT_PASSWORD = 'SenhaFixa@123';
const DEFAULT_EMAIL = 'email.fixo@example.com';
const TARGET_URL = 'https://account.eudemons.com/eo/QuickSignupEo.htm';
const CROXY_URL = 'https://www.croxyproxy.com/';

const sessions = new Map();

function generateUsername(prefix, start, end) {
  const startRaw = String(start).trim();
  const endRaw = String(end).trim();
  const min = Number(startRaw);
  const max = Number(endRaw);

  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
    throw new Error('Intervalo de sufixo inválido.');
  }

  const value = Math.floor(Math.random() * (max - min + 1)) + min;
  const suffixSize = Math.max(startRaw.length, endRaw.length);
  const suffix = String(value).padStart(suffixSize, '0');
  return `${prefix}${suffix}`;
}

function createSessionId() {
  return Math.random().toString(36).slice(2, 12);
}

async function getSignupFrame(page) {
  const maxAttempts = 20;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const frames = page.frames();

    const v2Frame = frames.find((frame) => frame.url().toLowerCase().includes('quicksignupv2'));
    if (v2Frame) {
      return v2Frame;
    }

    const directFrame = frames.find((frame) => frame.url().toLowerCase().includes('quicksignupeo'));
    if (directFrame) {
      return directFrame;
    }

    const fallbackFrame = frames.find((frame) => frame.url().toLowerCase().includes('eudemons'));
    if (fallbackFrame) {
      return fallbackFrame;
    }

    await page.waitForTimeout(1000);
  }

  return page.mainFrame();
}

async function chooseTargetForm(forms) {
  const formCount = await forms.count();
  if (formCount === 0) {
    throw new Error('Nenhum formulário encontrado na página de cadastro.');
  }

  if (formCount >= 3) {
    return forms.nth(2);
  }

  let bestIndex = 0;
  let bestScore = -1;

  for (let i = 0; i < formCount; i += 1) {
    const form = forms.nth(i);
    const passwordCount = await form.locator('input[type="password"]').count();
    const captchaCount = await form.locator(
      'img[id*="captcha" i], img[name*="captcha" i], img[src*="captcha" i], img[id*="verify" i], img[src*="verify" i], img'
    ).count();
    const textCount = await form.locator('input[type="text"], input:not([type])').count();
    const score = (passwordCount * 3) + (captchaCount * 2) + textCount;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return forms.nth(bestIndex);
}

async function fillFormFields(formLocator, username, password, email) {
  const textInputs = formLocator.locator('input[type="text"], input:not([type])');
  const passwordInputs = formLocator.locator('input[type="password"]');
  const emailInputs = formLocator.locator('input[type="email"], input[name*="mail" i], input[id*="mail" i]');

  const textCount = await textInputs.count();
  if (textCount === 0) {
    throw new Error('Não foi encontrado campo de usuário no formulário de cadastro.');
  }

  await textInputs.nth(0).fill(username);

  const passCount = await passwordInputs.count();
  if (passCount > 0) {
    await passwordInputs.nth(0).fill(password);
  }
  if (passCount > 1) {
    await passwordInputs.nth(1).fill(password);
  }

  const emailCount = await emailInputs.count();
  if (emailCount > 0) {
    await emailInputs.nth(0).fill(email);
  } else if (textCount > 1) {
    await textInputs.nth(1).fill(email);
  }
}

async function extractCaptchaImage(formLocator) {
  const captchaCandidates = formLocator.locator(
    'img[id*="captcha" i], img[name*="captcha" i], img[src*="captcha" i], img[id*="verify" i], img[src*="verify" i], img[alt*="code" i], img'
  );

  const count = await captchaCandidates.count();
  if (count === 0) {
    return { imageBase64: null, selector: null };
  }

  for (let i = 0; i < count; i += 1) {
    const candidate = captchaCandidates.nth(i);
    try {
      const box = await candidate.boundingBox();
      if (!box || box.width < 40 || box.height < 20) {
        continue;
      }

      const imageBuffer = await candidate.screenshot({ type: 'png' });
      return {
        imageBase64: imageBuffer.toString('base64'),
        selector: `captcha-candidate-${i}`,
      };
    } catch {
      // Tenta próximo candidato
    }
  }

  return { imageBase64: null, selector: null };
}

async function findCaptchaInput(formLocator) {
  const captchaInput = formLocator.locator(
    'input[name*="captcha" i], input[id*="captcha" i], input[name*="verify" i], input[id*="verify" i], input[placeholder*="captcha" i], input[type="text"]'
  );

  const count = await captchaInput.count();
  if (count === 0) {
    return null;
  }

  return captchaInput.nth(Math.min(1, count - 1));
}

app.post('/api/start', async (req, res) => {
  const {
    prefixo,
    sufixoInicio,
    sufixoFim,
    senha = DEFAULT_PASSWORD,
    email = DEFAULT_EMAIL,
  } = req.body || {};

  if (!prefixo || sufixoInicio === undefined || sufixoFim === undefined || !senha || !email) {
    return res.status(400).json({ error: 'Preencha prefixo, início, fim, senha e e-mail.' });
  }

  let browser;
  try {
    const username = generateUsername(prefixo, sufixoInicio, sufixoFim);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(CROXY_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });

    const urlInput = page.locator('input[type="url"], input[name*="url" i], input[id*="url" i], input[type="text"]');
    await urlInput.first().fill(TARGET_URL);

    const goButton = page.locator('button:has-text("Go"), button:has-text("OK"), button[type="submit"], input[type="submit"]');
    await goButton.first().click();

    const frame = await getSignupFrame(page);

    await frame.waitForSelector('form', { timeout: 90000 });
    const forms = frame.locator('form');
    const formCount = await forms.count();
    const targetForm = await chooseTargetForm(forms);
    await fillFormFields(targetForm, username, senha, email);

    const captchaImage = await extractCaptchaImage(targetForm);

    if (!captchaImage.imageBase64) {
      throw new Error('Captcha não encontrado no formulário de cadastro selecionado.');
    }

    const captchaInputLocator = await findCaptchaInput(targetForm);

    const sessionId = createSessionId();
    sessions.set(sessionId, {
      browser,
      context,
      page,
      frame,
      createdAt: Date.now(),
      captchaInputLocator,
      formLocator: targetForm,
    });

    return res.json({
      sessionId,
      username,
      password: senha,
      email,
      captchaImage: `data:image/png;base64,${captchaImage.imageBase64}`,
      formsFound: formCount,
    });
  } catch (error) {
    if (browser) {
      await browser.close();
    }
    return res.status(500).json({ error: error.message || 'Falha ao iniciar automação.' });
  }
});

app.post('/api/submit-captcha', async (req, res) => {
  const { sessionId, captchaTexto } = req.body || {};

  if (!sessionId || !captchaTexto) {
    return res.status(400).json({ error: 'Informe sessionId e captchaTexto.' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada ou expirada.' });
  }

  try {
    if (session.captchaInputLocator) {
      await session.captchaInputLocator.fill(captchaTexto);
    }

    const submitButton = session.formLocator.locator(
      'button[type="submit"], input[type="submit"], button:has-text("Register"), button:has-text("Sign"), button:has-text("Submit")'
    );

    if ((await submitButton.count()) > 0) {
      await submitButton.first().click();
    }

    await session.page.waitForTimeout(2000);
    const currentUrl = session.page.url();

    await session.browser.close();
    sessions.delete(sessionId);

    return res.json({
      message: 'Captcha enviado. Verifique o resultado no destino.',
      currentUrl,
    });
  } catch (error) {
    await session.browser.close();
    sessions.delete(sessionId);
    return res.status(500).json({ error: error.message || 'Falha ao enviar captcha.' });
  }
});

setInterval(async () => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.createdAt > 10 * 60 * 1000) {
      try {
        await session.browser.close();
      } catch {
        // ignora
      }
      sessions.delete(sessionId);
    }
  }
}, 60 * 1000);

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
