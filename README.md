# ATLAS INVESTMENT COMMITTEE — AI EQUITY RESEARCH LAB

Comité de inversión autónomo de **cuatro agentes de IA** (Quality, Valuation, Risk y CIO) que investigan acciones estadounidenses con datos públicos gratuitos, debaten entre sí con mensajes reales y almacenados, revisan sus conclusiones y emiten una decisión final **trazable** hasta sus fuentes y supuestos.

> Las estimaciones no son garantías de rentabilidad. El 15 % anual es un **objetivo de selección**, no una previsión. Recomendar **cero** compras es un resultado válido. No es asesoramiento financiero.

![Overview](docs/screenshots/overview-dark.png)

---

## 1. Qué hace (resumen de lo implementado)

| Área | Implementación |
|---|---|
| **Orquestador real** | `src/lib/orchestrator/runner.ts`: máquina de estados validada (`src/lib/state.ts`). Cada intervención de cada agente es **una llamada diferenciada al modelo** con su propia instrucción de sistema, su contexto autorizado y sus herramientas. Nada de "cuatro textos en una respuesta". |
| **Ronda 1 independiente** | Cuatro tareas en paralelo (concurrencia limitada). El *context broker* (`src/lib/agents/broker.ts`) impide leer informes ajenos hasta que los cuatro informes existen y se **congelan** (trigger SQLite que bloquea `UPDATE`/`DELETE`). Fallo de un agente → estado `FAILED` solo para él, reintento individual. |
| **Ronda 2A lectura cruzada** | Cada agente recibe los 4 informes congelados + registro de evidencias y entrega 3 argumentos sólidos, 3+ objeciones, errores factuales, hipótesis discutibles, preguntas y cambios en la lista. |
| **Ronda 2B debate estructurado** | Por empresa: Quality expone → Valuation cuestiona precio → Risk objeta → **responden los analistas aludidos** (agente↔agente) → el CIO clasifica controversias (FACTUAL / FORECAST / JUDGEMENT), asigna responsable y acción. Cada mensaje tiene emisor, destinatario, ticker, tipo, afirmación, evidencia (EV-n), pregunta, resultado esperado y `in_reply_to`. |
| **Ronda 2C verificación** | Las discrepancias factuales se convierten en incidencias con historial. Se resuelven **solo con evidencia VERIFICADA** (comprobación determinista contra el registro o tarea documental del agente asignado); nunca por votación. Previsiones discrepantes → hipótesis alternativas con su consecuencia calculada por el motor. |
| **Ronda 3 revisión** | Cada agente entrega puntuación/conclusión revisadas, argumentos aceptados/rechazados, datos nuevos y cuestiones sin resolver. Se guardan como **versión nueva**; el informe inicial es inmutable. |
| **Ronda 4 debate selectivo** | El CIO elige solo controversias que pueden cambiar la decisión (señales del motor: divergencia calidad/valoración, CAGR cerca del umbral, pérdida permanente, datos no verificados, sensibilidad del precio de entrada). Respuesta dirigida + una ronda adicional de revisión (configurable). |
| **Decisión final** | El CIO puntúa catalizadores y propone veredictos; el **motor determinista** (`src/lib/finance/scoring.ts`) calcula la puntuación final (30/30/20/15/5 con penalización por riesgo), aplica vetos y **limita** el veredicto máximo permitido (el CIO puede ser más prudente, nunca menos). Ranking de **0 a 5** empresas, nunca rellenado. Convergencia `RESOLVED / PARTIAL / UNRESOLVED / STOPPED_BY_BUDGET / STOPPED_BY_USER / FAILED`. |
| **Datos públicos** | Módulo `src/lib/market-data` con interfaces de proveedor intercambiables: SEC EDGAR (tickers+bolsa, *submissions*, XBRL *companyfacts*, *frames*, búsqueda de texto completo), Stooq (precio retrasado), Alpha Vantage (opcional, clave gratuita), BCE (EUR/USD), precios del usuario vía CSV, y un proveedor **sintético** exclusivo del modo demo. |
| **Registro de evidencias** | `src/lib/evidence/registry.ts`: ticker, métrica, valor, unidad, periodo y tipo de periodo, base GAAP/non-GAAP, fecha de publicación y de recuperación, fuente, URL, tipo (reportado / calculado / estimado / no verificado), fórmula e inputs, confianza y motivo. Solo el sistema puede crear `VERIFIED`; los agentes no se autocertifican. Discrepancias entre fuentes → se conservan ambas + incidencia `DATA_CONFLICT`. |
| **Verificación de fuentes** | Herramienta `verify_source`: abre la URL (solo https públicas, guardia SSRF, tamaño y tiempo limitados), comprueba que el **fragmento literal** está en la página → `VERIFIED`; si no aparece → `UNVERIFIED`; si no abre → `UNREACHABLE`. El contenido recuperado se trata como dato no confiable. |
| **Motor de cálculo** | `src/lib/finance/*`: CAGR, rentabilidad total con dividendos (sin doble conteo), precio máximo compatible con el objetivo, precio de entrada, margen de seguridad, DCF + sensibilidad, múltiplos, conversión USD/EUR y rentabilidad en EUR con sensibilidad de divisa, guardas que impiden mezclar trimestral/anual, USD/EUR o GAAP/non-GAAP. Datos ausentes → `null`, nunca cero. |
| **Control de costes** | Estimación previa, presupuesto y límite de llamadas por sesión, límites de tokens por llamada, comprobación **antes de cada llamada** del peor caso, reserva del presupuesto para el veredicto del CIO, uso real (tokens reportados por la API) por agente y por fase, coste etiquetado como **estimado**, tabla de precios editable, modo **en seco** sin IA. |
| **Dashboard** | Next.js + Tailwind: Overview, Committee Room, Debate en directo (filtros por agente, ticker, ronda y tipo), Research (candidatas, informes, revisiones, evidencias, incidencias, historial de puntuaciones, exportación), Final Ranking (orden y filtros), ficha de empresa y Settings. Modo claro/oscuro, responsive, estados vacíos útiles. |
| **Persistencia y reanudación** | SQLite (`node:sqlite`, sin dependencias nativas). Las tareas completadas nunca se repiten; las que quedaron `RUNNING` tras un cierre se re-encolan. Los efectos de cada tarea se aplican en una transacción junto con su marca de éxito. |
| **Exportación** | Informe final (Markdown), tabla comparativa (CSV), informes por agente, transcripción del debate, evidencias y fuentes, historial de puntuaciones; todas con fecha de corte, modelo, fuentes, limitaciones, estado de verificación y advertencia. Redacción de secretos. |

## 2. Estructura de archivos

```
src/
  app/                         # Páginas (A–G) y API routes (App Router)
    page.tsx                   # A · Overview + iniciar comité (estimación, consentimiento)
    committee/ debate/ research/ ranking/ company/[ticker]/ settings/
    api/settings  api/estimate  api/csv
    api/sessions  api/sessions/[id]  …/action  …/export  …/company/[ticker]
  components/                  # Shell, UI, gráficos (Recharts), hooks de polling
  lib/
    config.ts                  # Objetivo de inversión, límites, tabla de precios (Zod)
    types.ts  state.ts         # Roles, estados, transiciones validadas
    db/index.ts  db/repo.ts    # Esquema SQLite (+ triggers de inmutabilidad) y repositorio
    agents/profiles.ts         # 4 perfiles: instrucciones de sistema y criterios de puntuación
    agents/schemas.ts          # Esquemas Zod de todas las salidas de los agentes
    agents/broker.ts           # Control de acceso a informes (independencia de la ronda 1)
    llm/adapter.ts anthropic.ts scripted.ts cost.ts
    market-data/               # SEC, precios, FX, sintético, descubrimiento, CSV
    evidence/registry.ts       # Registro centralizado de evidencias
    finance/                   # returns, valuation, fundamentals, scoring (deterministas)
    orchestrator/              # runner (fases), agentTask (bucle de herramientas), tools, prompts, manager
    export/  security/  view.ts api.ts
tests/                         # 67 pruebas (Vitest)
docs/screenshots/              # Capturas de una sesión DEMO (datos sintéticos)
```

## 3. Instalación y arranque

Requisitos: **Node.js ≥ 22.13** (usa el módulo integrado `node:sqlite`; no hay que compilar nada nativo).

```bash
git clone <repo> && cd atlas-investment-committee
npm install
cp .env.example .env.local      # y rellene las variables (ver abajo)
npm run dev                     # http://localhost:3000
# producción local:
npm run build && npm start
# comprobaciones:
npm test            # pruebas
npm run typecheck   # TypeScript
npm run lint        # ESLint
```

La base de datos se crea en `./data/atlas.db` (configurable con `ATLAS_DB_PATH`). Node mostrará un aviso `ExperimentalWarning: SQLite` — es normal.

## 4. Variables de entorno (`.env.local`, solo servidor)

| Variable | Obligatoria | Uso |
|---|---|---|
| `ANTHROPIC_API_KEY` | Para el modo real | Clave de la API de Anthropic. Nunca llega al navegador, ni a SQLite, logs o exportaciones. |
| `SEC_USER_AGENT` | Para datos reales | La SEC exige un User-Agent con contacto, p. ej. `Atlas Research tu@email.com`. |
| `ALPHAVANTAGE_API_KEY` | No | Proveedor de precios alternativo (plan gratuito). La URL guardada se redacta. |
| `ATLAS_DB_PATH` | No | Ruta del fichero SQLite. |

`.env*` está en `.gitignore` (salvo `.env.example`).

## 5. Configurar el modelo

En **Settings → Modelo y clave**:

- **Modelo principal** (informes iniciales, revisiones, decisión del CIO). Por defecto `claude-opus-5-5`.
- **Modelo de debate y verificación** (el "modelo de calidad" configurable para los turnos de debate).
- **Esfuerzo** (`low`…`max`): más esfuerzo = más tokens.
- **Tabla de precios** (USD por millón de tokens, editable; los valores por defecto deben contrastarse con https://www.anthropic.com/pricing). Un modelo sin precio — o con precio 0 — no puede usarse en una sesión real, porque el presupuesto no sería controlable.
- Opcional: *fallback* de servidor ante rechazos (beta; se desactiva solo si la API lo rechaza) y búsqueda web del servidor (coste adicional; sus resultados siempre quedan como NO VERIFICADOS).

## 6. Iniciar el primer comité

1. **Demostración (sin clave, sin red, sin coste):** Overview → *Demostración* → *Iniciar demostración*. Ejecuta las 4 rondas completas con empresas **ficticias** `DEMO-*` y un adaptador de modelo *scripted*. Todo está etiquetado como SINTÉTICO y nunca se mezcla con sesiones reales.
2. **Análisis en seco:** configure `SEC_USER_AGENT`, elija *Análisis en seco*. Descarga el universo de la SEC, criba candidatas y calcula la estimación de coste **sin ninguna llamada de IA**.
3. **Comité real:** configure `ANTHROPIC_API_KEY` y `SEC_USER_AGENT`, revise en Settings el objetivo, universo, sectores excluidos, presupuesto y límites; en Overview elija *Comité real*, revise la estimación (llamadas, agentes, rondas, modelo, presupuesto), marque el consentimiento y pulse *Iniciar comité (de pago)*. Siga el progreso en **Committee Room** y **Debate**; el resultado queda en **Final Ranking** y en las fichas de empresa. Puede **Detener**, **Reanudar** o **Reintentar** una tarea fallida.

Opcional: en Settings → *Universo* importe tickers por CSV (`ticker[,precio,fecha]`); se combinan con las candidatas descubiertas, o se analizan en exclusiva si marca la casilla correspondiente.

## 7. Control del gasto

- **Presupuesto máximo por sesión (USD)** y **llamadas máximas por sesión**: antes de *cada* llamada se calcula el peor caso (tokens de entrada estimados + máximo de salida × precio). Si superaría el disponible, la llamada **no se hace**.
- **Reserva para el veredicto** (15 % por defecto): las fases de debate no pueden gastarla. Al agotarse el presupuesto el debate se **detiene de forma controlada**, el CIO documenta los desacuerdos pendientes con la reserva y la convergencia queda `STOPPED_BY_BUDGET`.
- Límites de **tokens de entrada/salida por llamada**, **iteraciones de herramientas por tarea**, **rondas de debate** (1–2), **ronda adicional de revisión** (0–1), **verificaciones por empresa** y **concurrencia**.
- El uso real (tokens que devuelve la API) se registra por llamada, agente y fase; el coste se muestra siempre como **estimado** (tokens × tabla configurada). El modo demo registra coste 0 (simulado).
- La aplicación **no hace llamadas de pago al arrancar**: solo cuando se inicia una sesión real con consentimiento explícito.

## 8. Resultado real de las comprobaciones (en este entorno)

```
npm test           → Test Files 7 passed (7) · Tests 67 passed (67)
npm run typecheck  → sin errores
npm run lint       → sin errores ni avisos
npm run build      → compilación de producción correcta (Next.js 15.5)
```

Las pruebas cubren los 15 requisitos: perfiles distintos (1), prompts de ronda 1 sin contenido ajeno y broker que deniega la lectura (2–3), debate bloqueado hasta 4 informes (4), mensajes persistidos y filtrables (5), objeciones → incidencias resueltas solo con evidencia (6), informes congelados inmutables y revisiones versionadas (7), matemáticas financieras (8), cifras sin fuente nunca verificadas + `verify_source` + guardia SSRF (9), límites de coste que detienen llamadas y parada controlada (10), errores sin pérdida de resultados y reintento individual (11), ranking con <5 y 0 empresas (12), exportaciones con cabecera y sin secretos (13), datos sintéticos aislados y sin tickers reales codificados en la UI (14), reanudación sin duplicar tareas (15), además de un flujo completo de extremo a extremo.

Verificaciones manuales hechas: servidor de producción arrancado, sesión demo completa vía API HTTP (COMPLETED, 86 mensajes, 341 evidencias), análisis en seco, exportaciones, y capturas de todas las pantallas en claro/oscuro y a 390 px de ancho (sin desbordamiento horizontal ni errores de consola).

**Lo que NO se ha podido comprobar aquí:** la red de este entorno bloquea `sec.gov`, `stooq.com` y el BCE, y no había clave de Anthropic. Por tanto **no se ha consultado ningún dato financiero real ni se ha ejecutado ninguna llamada real al modelo**. Los proveedores están implementados contra las APIs públicas documentadas y probados con respuestas simuladas; el adaptador de Anthropic se probó solo hasta obtener un `401 authentication_error` con una clave inválida (confirma la ruta de la llamada, no el contenido). La primera ejecución real debería hacerse con un presupuesto bajo.

## 9. Limitaciones conocidas

- **Cobertura parcial del universo:** el cribado usa los *frames* XBRL de la SEC por año natural; quedan fuera emisores sin etiquetas estándar o con ejercicio desalineado. La app lo etiqueta como *Universo parcial* y nunca afirma cobertura exhaustiva. El segmento por capitalización no se criba en el descubrimiento.
- **Precios gratuitos retrasados** (Stooq no documenta la zona horaria); se muestran con fecha, hora y tipo. Sin precio verificado no hay CAGR ni compra posible.
- **ROIC aproximado** (sin ajustar fondo de comercio ni arrendamientos), deuda neta solo con la etiqueta de deuda a largo plazo; ambos marcados con confianza media/baja.
- `verify_source` comprueba coincidencia **literal** del fragmento citado; no interpreta tablas ni PDFs escaneados.
- La resolución determinista de incidencias exige que la métrica y el periodo coincidan con un dato del 10-K; en otro caso pasa a verificación documental por un agente y, si no hay evidencia verificada, queda **pendiente**.
- La estimación previa de coste es heurística; el control duro es el chequeo previo a cada llamada.
- Las sesiones se ejecutan en el proceso del servidor Next.js (aplicación local de un solo usuario); si se cierra, la sesión queda *interrumpida* y se reanuda desde la última tarea completada.
- `node:sqlite` es experimental en Node 22 (estable en versiones posteriores).

## 10. Mejoras recomendadas para una v2

1. Cola de trabajos persistente separada del servidor web (worker) y notificaciones en tiempo real (SSE) en lugar de *polling*.
2. Descarga y lectura de los documentos 10-K/10-Q completos (secciones *Risk Factors*, MD&A) con citas por página, y comparables sectoriales automáticos.
3. Fuente de precios con licencia clara y precios de cierre ajustados históricos para valoración histórica (rangos de PER/EV-EBIT).
4. Uso de la API de recuento de tokens antes de cada llamada para afinar el peor caso, y tablero de coste por empresa.
5. Detección automática de cifras citadas en texto libre por los agentes y conciliación contra el registro.
6. Evaluaciones (*evals*) del comité sobre casos históricos con resultados conocidos.
7. Multiusuario con autenticación si se despliega fuera de la máquina local.

---

### Seguridad

Claves solo en variables de entorno del servidor; las respuestas de la API y las exportaciones pasan por un redactor de secretos; las mutaciones exigen el mismo origen; las URLs que abren los agentes pasan una guardia SSRF; el contenido recuperado se envuelve como dato no confiable; los agentes no ejecutan código ni pueden modificar instrucciones, configuración o límites (solo disponen de herramientas de datos y cálculo en lista blanca).
