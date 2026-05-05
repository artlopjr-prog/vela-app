// VĒLA · API de Chat
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' })
  try {
    const { mode, message, provider, model, conversation_id } = req.body
    if (!message?.trim()) return res.status(400).json({ error: 'Mensaje vacío' })
    const token = req.headers.authorization?.replace('Bearer ', '')
    let userId = null, userProfile = null
    if (token) {
      const { data: { user } } = await supabase.auth.getUser(token)
      if (user) {
        userId = user.id
        const { data: profile } = await supabase.from('business_profiles').select('*').eq('user_id', userId).single()
        userProfile = profile
      }
    }
    let convId = conversation_id
    if (!convId && userId) {
      const { data: newConv } = await supabase.from('conversations').insert({ user_id: userId, mode, title: message.slice(0, 60) }).select().single()
      convId = newConv?.id
    }
    let history = []
    if (convId) {
      const { data: msgs } = await supabase.from('messages').select('role, content').eq('conversation_id', convId).order('created_at', { ascending: true }).limit(20)
      history = msgs || []
    }
    if (convId && userId) await supabase.from('messages').insert({ conversation_id: convId, user_id: userId, role: 'user', content: message, provider, model })
    const systemPrompt = buildSystemPrompt(mode, userProfile)
    const msgs = [...history, { role: 'user', content: message }]
    let reply = '', tokensUsed = 0
    if (provider === 'anthropic') { const r = await callAnthropic(systemPrompt, msgs, model); reply = r.content; tokensUsed = r.tokens }
    else { const r = await callGroq(systemPrompt, msgs, model); reply = r.content; tokensUsed = r.tokens }
    if (convId && userId) {
      await supabase.from('messages').insert({ conversation_id: convId, user_id: userId, role: 'assistant', content: reply, tokens_used: tokensUsed, provider, model })
      if (mode === 'diag' && userProfile) await extractAndUpdateProfile(msgs, reply, userId)
    }
    return res.status(200).json({ reply, conversation_id: convId, tokens_used: tokensUsed })
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Error interno' })
  }
}
async function callAnthropic(system, messages, model) {
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: model || 'claude-sonnet-4-20250514', max_tokens: 2500, temperature: 0.7, system, messages }) })
  if (!r.ok) { const e = await r.json(); throw new Error(e.error?.message || 'Anthropic error') }
  const d = await r.json()
  return { content: d.content[0].text, tokens: (d.usage?.input_tokens||0)+(d.usage?.output_tokens||0) }
}
async function callGroq(system, messages, model) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` }, body: JSON.stringify({ model: model||'llama-3.3-70b-versatile', max_tokens: 2500, temperature: 0.7, messages: [{role:'system',content:system},...messages] }) })
  if (!r.ok) { const e = await r.json(); throw new Error(e.error?.message || 'Groq error') }
  const d = await r.json()
  return { content: d.choices[0].message.content, tokens: (d.usage?.prompt_tokens||0)+(d.usage?.completion_tokens||0) }
}
function buildSystemPrompt(mode, profile) {
  const m = buildMemory(profile)
  const p = {
    diag: `Eres VĒLA, socio estratégico IA para emprendedores LATAM. ${m} Haz 1-2 preguntas inteligentes por mensaje. Cuando tengas info suficiente presenta SNAPSHOT DEL NEGOCIO. Tono: directo, empático.`,
    valid: `Eres VĒLA en VALIDACIÓN. ${m} SIEMPRE incluye Puntuación de viabilidad: X/10. Dimensiones: Problema, Mercado, Diferenciación, Modelo, Timing. Riesgos top 3, oportunidades, 3 experimentos con $0.`,
    pitch: `Eres VĒLA en SIMULADOR DE PITCH. ${m} Actúas como VC 15 años LATAM. Escéptico, directo. Preguntas difíciles. Después de 5-7 preguntas da VEREDICTO: Invertiría/No invertiría.`,
    road: `Eres VĒLA en RUTA DE LANZAMIENTO. ${m} Usa formato: ROADMAP:SEMANA_1:[título]|[tarea1]|[tarea2]|[tarea3]. 8-12 semanas, tareas concretas.`,
    strat: `Eres VĒLA en ESTRATEGIA LATAM. ${m} Contexto profundo de México, Colombia, Argentina, Chile, Panamá, Perú. Planes concretos adaptados al país.`,
    comp: `Eres VĒLA en ANÁLISIS DE COMPETENCIA. ${m} Formato: COMPETIDOR:[nombre]|[tipo]|[precio]|[fortaleza]|[debilidad]|[cuota]. 3-5 competidores. Gap y diferenciación.`,
    price: `Eres VĒLA en CALCULADORA DE PRECIO. ${m} Formato: PRECIO_OPTIMO:[precio]|[desc] PRECIO_BASICO:[precio]|[tier] PRECIO_PREMIUM:[precio]|[tier]. Value-based pricing LATAM.`,
    social: `Eres VĒLA en REDES SOCIALES. ${m} 5 mejoras inmediatas, plan semanal, 3 formatos. Adapta a LATAM: Instagram, WhatsApp Business.`,
    docs: `Eres VĒLA en DOCUMENTOS. ${m} Documentos COMPLETOS adaptados a LATAM: plan negocio, pitch deck, contratos, NDA, OKRs.`,
    fin: `Eres VĒLA en DIAGNÓSTICO FINANCIERO. ${m} Runway, margen, punto equilibrio, 3 huecos críticos, 3 acciones para mejorar flujo.`,
    invest: `Eres VĒLA en RUTA DE INVERSIÓN. ${m} Inversión en LATAM: valuación, tipo inversor, material, due diligence, term sheet. YC, Endeavor, Start-Up Chile, iNNpulsa.`
  }
  return p[mode] || p.diag
}
function buildMemory(profile) {
  if (!profile || !profile.idea) return ''
  const parts = ['MEMORIA:']
  if (profile.idea) parts.push(`Negocio: ${profile.idea}`)
  if (profile.stage) parts.push(`Etapa: ${profile.stage}`)
  if (profile.country) parts.push(`País: ${profile.country}`)
  if (profile.monthly_revenue > 0) parts.push(`Ingresos: $${profile.monthly_revenue}/mes`)
  if (profile.main_blocker) parts.push(`Bloqueo: ${profile.main_blocker}`)
  return parts.join(' | ') + ' | Usa esta memoria en tu respuesta.'
}
async function extractAndUpdateProfile(messages, reply, userId) {
  try {
    const text = messages.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 2000)
    const r = await callAnthropic('Solo JSON sin explicaciones.', [{ role: 'user', content: `Extrae datos del emprendedor. Solo JSON: {"idea":"","stage":"","country":"","city":"","monthly_revenue":0,"active_customers":0,"main_blocker":"","goals_3m":""}\nTexto: ${text}` }], 'claude-haiku-4-5-20251001')
    const extracted = JSON.parse(r.content.replace(/```json\n?/g,'').replace(/```/g,'').trim())
    const updates = {}
    Object.entries(extracted).forEach(([k,v]) => { if (v !== null && v !== undefined && v !== '' && v !== 0) updates[k] = v })
    if (Object.keys(updates).length > 0) await supabase.from('business_profiles').update(updates).eq('user_id', userId)
  } catch(e) {}
}
