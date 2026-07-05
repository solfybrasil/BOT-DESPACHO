require('dotenv').config();
const wppconnect = require('@wppconnect-team/wppconnect');
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SESSION_NAME = process.env.SESSION_NAME || 'solfy-whatsapp';
const POLL_INTERVAL_MS = 5000; // verifica novos pedidos a cada 5 segundos

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórios no .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Banco de Histórico (Solfy Pro App) para envio de notificações aos prestadores
const HISTORY_SUPABASE_URL = 'https://ykxyfvkdzqqiefdjwhvt.supabase.co';
const HISTORY_SUPABASE_ANON_KEY = 'sb_publishable_IWjzmKA-73MP4u32u__-Fw_PSHgariD';
const supabaseHistory = createClient(HISTORY_SUPABASE_URL, HISTORY_SUPABASE_ANON_KEY);

// ─── Tratamento de Erros Globais ─────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('🚨 CRITICAL ERROR (Uncaught Exception):', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 CRITICAL ERROR (Unhandled Rejection):', reason);
});

// ─── Estado global ────────────────────────────────────────────────────────────
let whatsappClient = null;
let connectionStatus = 'disconnected';
let currentQrCode = null;
let lastCheckedAt = new Date().toISOString(); 

// ─── Express ─────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    qrCode: connectionStatus === 'qr_pending' ? currentQrCode : null,
    lastCheckedAt,
    message: {
      disconnected: 'Desconectado.',
      qr_pending: 'Aguardando QR Code.',
      connected: 'WhatsApp conectado e monitorando pedidos!',
    }[connectionStatus],
  });
});

// ─── WPPConnect ───────────────────────────────────────────────────────────────
async function initWhatsApp() {
  console.log('🔄 Iniciando WPPConnect...');
  connectionStatus = 'qr_pending';

  try {
    whatsappClient = await wppconnect.create({
      session: SESSION_NAME,
      catchQR: (base64Qr) => {
        console.log('📱 QR Code gerado! Acesse http://localhost:' + PORT + '/api/status');
        currentQrCode = base64Qr;
        connectionStatus = 'qr_pending';
      },
      statusFind: (statusSession) => {
        console.log('📡 WPP Status:', statusSession);
        if ((statusSession === 'inChat' || statusSession === 'isLogged') && connectionStatus !== 'connected') {
          connectionStatus = 'connected';
          currentQrCode = null;
          console.log('✅ WhatsApp conectado! Iniciando polling...');
          startPolling();
        }
      },
      autoClose: 120000,
      headless: true,
      puppeteerOptions: {
        executablePath: puppeteer.executablePath(),
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage', 
          '--disable-accelerated-2d-canvas',
          '--no-first-run', 
          '--no-zygote', 
          '--single-process', 
          '--disable-gpu',
          '--disable-extensions',
          '--js-flags="--max-old-space-size=250"'
        ],
      },
      logQR: false,
    });

    connectionStatus = 'connected';
    console.log('✅ WPPConnect pronto!');
    startPolling();
  } catch (err) {
    console.error('❌ Erro ao iniciar WPPConnect:', err.message);
    connectionStatus = 'disconnected';
    
    if (err.message.includes('Auto Close Called') || err.message.includes('browserClose')) {
      console.log('🔄 Reiniciando WPPConnect em 5 segundos...');
      setTimeout(initWhatsApp, 5000);
    }
  }
}

// ─── Polling ─────────────────────────────────────────────────────────────────
let pollingActive = false;
const processedIds = new Set();
const activeDispatches = new Set();

async function checkIfLinked(requestId) {
  const { data } = await supabase
    .from('request_helpers')
    .select('id')
    .eq('request_id', requestId)
    .limit(1);
  return data && data.length > 0;
}

async function runPhasedDispatch(requestId, category, city) {
  if (activeDispatches.has(requestId)) return;
  activeDispatches.add(requestId);

  console.log(`[Despacho Inteligente] Iniciando loop de despacho para pedido ${requestId} (${category} em ${city})`);

  try {
    const normalizeCity = (c) =>
      c.toLowerCase().replace(/-sp$/i, '').replace(/-rj$/i, '').trim();

    const pedidoCity = normalizeCity(city);
    const pedidoCategory = category.toLowerCase();

    // 1. Buscar todos os prestadores ativos do banco de histórico
    const { data: allHelpers, error: helpersError } = await supabaseHistory
      .from('helpers')
      .select('id, user_id, name, city, service_type, is_active, vinculo_count')
      .eq('is_active', true);

    if (helpersError) {
      console.error(`[Despacho] Erro ao buscar prestadores para pedido ${requestId}:`, helpersError.message);
      return;
    }

    // 2. Filtrar os que atendem a cidade e categoria
    const matchingHelpers = (allHelpers || []).filter(h => {
      const helperCity = normalizeCity(h.city || '');
      const helperService = (h.service_type || '').toLowerCase();

      const cityMatch = helperCity === pedidoCity ||
        helperCity.includes(pedidoCity) ||
        pedidoCity.includes(helperCity);

      const categoryMatch = helperService.includes(pedidoCategory) ||
        pedidoCategory.includes(helperService);

      return cityMatch && categoryMatch;
    });

    console.log(`[Despacho] Pedido ${requestId}: ${matchingHelpers.length} prestadores qualificados.`);
    if (matchingHelpers.length === 0) {
      console.log(`[Despacho] Nenhum prestador qualificado na região para pedido ${requestId}.`);
      return;
    }

    // 3. Agrupar por prioridade de vínculo
    const priorityHigh = matchingHelpers.filter(h => (h.vinculo_count || 0) >= 2);
    const priorityMedium = matchingHelpers.filter(h => (h.vinculo_count || 0) === 1);
    const priorityNormal = matchingHelpers.filter(h => (h.vinculo_count || 0) === 0);

    // Helper para enviar notificações
    const sendNotificationsToGroup = async (group, levelName) => {
      if (group.length === 0) return;

      // Buscar notificações já enviadas
      const { data: existingNotifs } = await supabaseHistory
        .from('helper_notifications')
        .select('helper_id')
        .eq('request_id', requestId);

      const notifiedHelperIds = new Set((existingNotifs || []).map(n => n.helper_id));

      const groupToNotify = group.filter(h => !notifiedHelperIds.has(h.id));

      if (groupToNotify.length === 0) {
        console.log(`[Despacho] Grupo ${levelName} do pedido ${requestId} já foi totalmente notificado.`);
        return;
      }

      console.log(`[Despacho] Enviando notificações para grupo ${levelName} do pedido ${requestId} (${groupToNotify.length} de ${group.length} prestadores)`);

      const notifications = groupToNotify.map(h => ({
        helper_id: h.id,
        title: 'Novo Pedido em sua Area!',
        message: `Novo pedido de ${category} em ${city}. Aceite agora!`,
        type: 'new_request',
        request_id: requestId,
        read: false,
      }));

      const { error } = await supabaseHistory
        .from('helper_notifications')
        .insert(notifications);
      if (error) {
        console.error(`[Despacho] Erro ao inserir notificações para pedido ${requestId} no grupo ${levelName}:`, error.message);
      }
    };

    // FASE 1: Alta prioridade
    console.log(`[Despacho] Pedido ${requestId} - Iniciando Fase 1...`);
    if (priorityHigh.length > 0) {
      await sendNotificationsToGroup(priorityHigh, 'Alta (vínculos >= 2)');
    }

    for (let i = 0; i < 5; i++) {
      if (await checkIfLinked(requestId)) {
        console.log(`[Despacho] Pedido ${requestId} vinculado na Fase 1.`);
        return;
      }
      await sleep(3000);
    }

    // FASE 2: Média prioridade
    console.log(`[Despacho] Pedido ${requestId} - Iniciando Fase 2...`);
    if (priorityMedium.length > 0) {
      await sendNotificationsToGroup(priorityMedium, 'Média (vínculo = 1)');
    }

    for (let i = 0; i < 5; i++) {
      if (await checkIfLinked(requestId)) {
        console.log(`[Despacho] Pedido ${requestId} vinculado na Fase 2.`);
        return;
      }
      await sleep(3000);
    }

    // FASE 3: Normal prioridade
    console.log(`[Despacho] Pedido ${requestId} - Iniciando Fase 3...`);
    if (priorityNormal.length > 0) {
      await sendNotificationsToGroup(priorityNormal, 'Normal (vínculo = 0)');
    }

    for (let i = 0; i < 10; i++) {
      if (await checkIfLinked(requestId)) {
        console.log(`[Despacho] Pedido ${requestId} vinculado na Fase 3.`);
        return;
      }
      await sleep(3000);
    }

    console.log(`[Despacho] Loop de despacho finalizado para pedido ${requestId}.`);
  } catch (err) {
    console.error(`[Despacho] Erro no processamento do despacho para pedido ${requestId}:`, err.message);
  } finally {
    activeDispatches.delete(requestId);
  }
}

async function resumePendingDispatches() {
  console.log('🔍 [Despacho] Verificando despachos pendentes para retomar...');
  try {
    const { data: pendingOrders, error } = await supabase
      .from('help_requests')
      .select('*')
      .eq('status', 'sent_to_helpers');

    if (error) {
      console.error('❌ Erro ao buscar despachos pendentes:', error.message);
      return;
    }

    if (pendingOrders && pendingOrders.length > 0) {
      for (const order of pendingOrders) {
        const isLinked = await checkIfLinked(order.id);
        if (!isLinked) {
          runPhasedDispatch(order.id, order.category, order.city);
        }
      }
    }
  } catch (err) {
    console.error('❌ Falha ao retomar despachos:', err.message);
  }
}

function startPolling() {
  if (pollingActive) return;
  pollingActive = true;
  console.log(`\n🔍 Polling ativo — monitorando pedidos a cada ${POLL_INTERVAL_MS / 1000}s...\n`);

  // Retoma loops de despacho interrompidos ao iniciar/conectar
  resumePendingDispatches();

  setInterval(async () => {
    try {
      const now = new Date().toISOString();

      // Buscar pedidos que mudaram de status ou foram criados
      const { data: orders, error } = await supabase
        .from('help_requests')
        .select('*')
        .in('status', ['new', 'sent_to_helpers', 'completed'])
        .gte('updated_at', lastCheckedAt)
        .order('updated_at', { ascending: true });

      if (error) {
        console.error('❌ Erro ao buscar pedidos:', error.message);
        return;
      }

      lastCheckedAt = now;

      if (orders && orders.length > 0) {
        for (const order of orders) {
          // Evita processar a mesma transição de status duas vezes
          const processKey = `${order.id}-${order.status}`;
          if (processedIds.has(processKey)) continue;

          processedIds.add(processKey);
          
          if (order.status === 'new') {
            await handleNewOrder(order);
          } else if (order.status === 'sent_to_helpers') {
            // Se o pedido foi enviado para os prestadores mas ainda não está vinculado, inicia o despacho
            const isLinked = await checkIfLinked(order.id);
            if (!isLinked) {
              runPhasedDispatch(order.id, order.category, order.city);
            }
          } else if (order.status === 'completed') {
            await handleCompletedOrder(order);
          }

          // Limpa cache antigo para não crescer infinitamente
          if (processedIds.size > 100) {
            const firstKey = processedIds.values().next().value;
            processedIds.delete(firstKey);
          }
        }
      }
    } catch (err) {
      console.error('❌ Erro no polling:', err.message);
    }
  }, POLL_INTERVAL_MS);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatWhatsappNumber(phoneStr) {
  const digits = phoneStr.replace(/\D/g, '');
  let phone = digits.startsWith('55') ? digits : `55${digits}`;

  // Se for número do Brasil e tiver 13 dígitos (55 + DDD de 2 dígitos + 9 + 8 dígitos)
  if (phone.startsWith('55') && phone.length === 13) {
    const ddd = parseInt(phone.substring(2, 4), 10);
    // DDDs maiores que 28 não usam o dígito 9 no WhatsApp
    if (ddd > 28) {
      // Remove o nono dígito (que está na posição index 4, logo após o DDD)
      phone = phone.substring(0, 4) + phone.substring(5);
    }
  }

  return `${phone}@c.us`;
}

// ─── Handlers ────────────────────────────────────────────────────────────────
async function handleNewOrder(order) {
  console.log(`📦 Novo pedido detectado: ${order.id}`);
  
  if (connectionStatus !== 'connected' || !whatsappClient) {
    console.log('⚠️ WhatsApp não conectado. Pulando...');
    return;
  }

  try {
    const target = formatWhatsappNumber(order.phone);

    // Mensagem 1: Confirmação
    const msg1 = `Olá! Recebemos seu pedido: *"${order.description}"*. 🚀\n\nEm breve nossos prestadores entrarão em contato. Fique atento a novas mensagens!`;
    
    // Mensagem 2: Código
    const code = order.id.split('-')[0].toUpperCase();
    const msg2 = `Este é o código que você usará para autorizar o prestador:\n\n\`\`\`${code}\`\`\`\n\n⚠️ *IMPORTANTE:* Este código NÃO deve ser entregue agora. Ele serve para você autorizar o prestador escolhido. Encaminhe este código APENAS para o prestador que você decidir contratar.`;

    console.log(`📲 Enviando mensagens para o cliente: ${target}`);
    await whatsappClient.sendText(target, msg1);
    await sleep(2000);
    await whatsappClient.sendText(target, msg2);
    console.log(`✅ Mensagens de novo pedido enviadas!`);

    // Atualiza status para 'sent_to_helpers' para seguir o fluxo do app
    await supabase.from('help_requests').update({ status: 'sent_to_helpers' }).eq('id', order.id);
    
  } catch (err) {
    console.error(`❌ Falha ao processar novo pedido ${order.id}:`, err.message);
  }
}

async function handleCompletedOrder(order) {
  console.log(`🏁 Pedido concluído detectado: ${order.id}`);

  if (connectionStatus !== 'connected' || !whatsappClient) {
    console.log('⚠️ WhatsApp não conectado. Pulando...');
    return;
  }

  try {
    const target = formatWhatsappNumber(order.phone);

    const msg = `Seu pedido foi concluído! 🎉\n\nPor favor, acesse o nosso site para avaliar o prestador. Obrigado por utilizar a Solfy!`;

    console.log(`📲 Enviando mensagem de conclusão para: ${target}`);
    await whatsappClient.sendText(target, msg);
    console.log(`✅ Mensagem de conclusão enviada!`);

    // Aqui poderíamos atualizar o status para 'closed' ou algo assim,
    // mas vamos apenas marcar no Set local que já processamos esta conclusão.
    
  } catch (err) {
    console.error(`❌ Falha ao processar conclusão do pedido ${order.id}:`, err.message);
  }
}

// ─── Utilitários ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🚀 SOLFY WhatsApp Backend - Porta ${PORT}`);
  initWhatsApp();
});
