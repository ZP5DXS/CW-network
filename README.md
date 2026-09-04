# CW Network Radio

**Una red mundial de radio CW virtual, en tiempo real, desde el
navegador.**

**Autor:** Mathias Maidana --- **ZP5DXS**\
**Proyecto:** CW Network Radio\
**Versión actual:** v0.25\
**Live demo:** [https://zp5dxs.github.io/CW-Network/](https://zp5dxs.github.io/CW-network/)
**Repositorio:** https://github.com/ZP5DXS/CW-Network

------------------------------------------------------------------------

## ¿Qué es CW Network Radio?

CW Network Radio intenta reproducir la **experiencia de operar una
estación de radioaficionado en CW** dentro del navegador.

No es simplemente un generador de Morse ni un chat disfrazado de radio.
El usuario sintoniza una banda, mueve un VFO continuo, escucha ruido,
QRN, QSB y otras estaciones, selecciona filtros, potencia y antena, gira
una Yagi con rotor y transmite mediante llave recta o paddle.

Las estaciones humanas comparten el mismo espacio de radio en tiempo
real mediante WebSocket. A ellas se suman operadores virtuales que
mantienen las bandas vivas: llaman CQ, escuchan, cazan estaciones,
cambian de frecuencia y realizan QSOs.

La filosofía del proyecto es sencilla:

> **No simular la ionosfera de forma rígida. Simular la experiencia de
> hacer radio.**

Las condiciones, distancia, antena, potencia y propagación modifican la
**dificultad y el carácter de la recepción**, pero el sistema evita
convertir la propagación en una barrera absoluta que impida practicar o
encontrarse.

------------------------------------------------------------------------

## Probar ahora

### Radio

**https://zp5dxs.github.io/CW-Network/**

Al entrar:

1.  Introduzca su **indicativo**.
2.  Introduzca su **locator Maidenhead**.
3.  Haga clic o interactúe con la radio para habilitar el audio del
    navegador.
4.  Seleccione una banda.
5.  Sintonice manualmente o utilice **SCAN**.
6.  Escuche actividad o llame CQ.
7.  Utilice llave recta, paddle, teclado, mouse o una interfaz que
    genere las teclas compatibles.

------------------------------------------------------------------------

# La radio

## Bandas disponibles

CW Network Radio dispone actualmente de cinco bandas:

  Banda         Segmento virtual
  ------- ----------------------
  80 m        3.550 -- 3.560 MHz
  40 m        7.030 -- 7.040 MHz
  20 m      14.025 -- 14.035 MHz
  15 m      21.025 -- 21.035 MHz
  10 m      28.020 -- 28.030 MHz

Cada banda es un **segmento continuo de VFO**, no una colección de
canales.

Dos estaciones pueden estar en la misma banda y no escucharse
correctamente si no están suficientemente próximas en frecuencia.

------------------------------------------------------------------------

## VFO: NORMAL, FAST y SCAN

El control de sintonía dispone de tres modos:

### NORMAL

Sintonía fina normal según el STEP seleccionado.

### FAST

Multiplica la velocidad de desplazamiento para recorrer rápidamente el
segmento.

### SCAN

El receptor barre automáticamente la banda buscando transmisiones.

Cuando detecta actividad suficientemente próxima:

**TUNE · SCAN HOLD**

La radio se detiene sobre la señal para permitir escucharla. Después del
período de silencio continúa explorando.

Mover manualmente el dial, hacer clic en el waterfall o cambiar de banda
cancela el SCAN y devuelve la radio a operación normal.

------------------------------------------------------------------------

# CW y manipulación

## Llave recta

La transmisión humana se transporta por la red como eventos reales de:

-   `key_down`
-   `key_up`

Por lo tanto, el servidor no transmite un texto convertido a Morse en
nombre del operador. Se conserva el **timing real de su puño**.

Entradas disponibles incluyen:

-   barra espaciadora;
-   teclas Ctrl;
-   `[ ]`;
-   mouse / superficie de manipulación.

Esto permite utilizar adaptadores de llave que se presenten al navegador
como teclado.

------------------------------------------------------------------------

## Paddle

La radio incorpora keyer electrónico con modos:

-   **Iambic A**
-   **Iambic B**
-   **BUG**

También puede invertirse la asignación de dit/dah.

El WPM configurado gobierna el keyer electrónico y sirve además como
referencia inicial para algunos procesos de decodificación.

------------------------------------------------------------------------

# Frecuencia, tono y filtro

La estación remota transmite en una frecuencia objetiva.

El receptor genera el audio localmente. Al sintonizar correctamente, la
señal se escucha alrededor del tono CW seleccionado. Al desplazarse de
frecuencia cambia el tono percibido hasta salir de la ventana de
recepción.

Los filtros disponibles modifican la captura efectiva alrededor de la
frecuencia sintonizada.

Actualmente:

  Filtro      Captura aproximada
  --------- --------------------
  600 Hz                 ±300 Hz
  1800 Hz                ±450 Hz
  2500 Hz                ±500 Hz

El filtro estrecho facilita separar estaciones próximas y reduce además
el ruido percibido.

------------------------------------------------------------------------

# Ruido, QRN, QSB, NB y NR

La radio genera localmente un ambiente de banda dinámico.

## Diferencias entre bandas

El sistema busca que cada banda tenga un carácter distinto.

### 80 metros

Es la banda más ruidosa del conjunto.

-   mayor piso de ruido;
-   mayor frecuencia de impulsos QRN;
-   ambiente más pesado;
-   favorece la sensación de operación en banda baja.

### 40 metros

También presenta ruido y QRN importantes, aunque algo menores que 80 m.

Es una banda especialmente apropiada para actividad CW cotidiana y QSOs
más tranquilos.

### 20 metros

Nivel intermedio y una personalidad más orientada a enlaces de
media/larga distancia.

### 15 metros

Más limpia y más sensible al nivel de actividad solar utilizado por el
modelo.

### 10 metros

La más limpia de las cinco en cuanto al ruido base implementado y la que
recibe mayor influencia relativa del **Solar Flux Index**.

Estas diferencias son deliberadas: las bandas bajas se sienten más
ruidosas y las altas más limpias.

------------------------------------------------------------------------

## QSB

Las señales remotas poseen un desvanecimiento lento y continuo.

No se trata de apagar y encender arbitrariamente una estación: su
amplitud varía suavemente con el tiempo para proporcionar la sensación
de fading.

------------------------------------------------------------------------

## QRN

Se generan impulsos de ruido de forma irregular.

La tasa es mayor en 80/40 m y menor progresivamente en 20/15/10 m.

El **NB** reduce fuertemente estos impulsos.

------------------------------------------------------------------------

## NR

El **Noise Reduction** reduce el piso general de ruido y también atenúa
parte del QRN.

NB y NR tienen funciones diferentes y pueden utilizarse conjuntamente.

------------------------------------------------------------------------

# Propagación y condiciones solares

CW Network Radio obtiene información de **NOAA SWPC** y utiliza
actualmente:

-   **Kp**
-   **Solar Flux Index (SFI / F10.7)**

Estos valores aparecen en la interfaz.

La propagación no pretende ser un modelo ionosférico científico
completo. Se utiliza para modificar de forma moderada la experiencia de
recepción.

## Kp

Cuando Kp supera aproximadamente 3, el factor de propagación comienza a
reducirse progresivamente.

## SFI

El Solar Flux afecta principalmente a las bandas altas:

-   10 m: influencia mayor;
-   15 m: influencia importante;
-   20 m: influencia moderada;
-   40/80 m: el código actual no aplica el mismo refuerzo directo por
    SFI.

La intención es que unas condiciones solares buenas hagan que las bandas
altas se sientan algo más favorables sin convertirlas en
"abiertas/cerradas" de forma absoluta.

------------------------------------------------------------------------

# Locator Maidenhead, distancia y rumbo

El **locator no es decorativo**.

CW Network Radio convierte los locators Maidenhead de la estación local
y de la estación remota en coordenadas aproximadas.

Acepta actualmente formatos Maidenhead válidos de 4, 6 u 8 caracteres.

Con ambas posiciones calcula:

-   **distancia de gran círculo**, en kilómetros;
-   **bearing inicial**, de 0° a 360°.

Ese cálculo se utiliza tanto para la influencia moderada de la distancia
como, especialmente, para la antena direccional.

Por eso es recomendable introducir un locator correcto.

------------------------------------------------------------------------

# Antenas

La estación ofrece actualmente dos sistemas:

## ANT 1 --- 3 elementos Yagi

Es una antena direccional.

Cuando se selecciona ANT 1 se habilita el rotor.

El sistema calcula el bearing real entre:

**su locator → locator de la estación recibida**

y compara ese bearing con el azimut real de la Yagi.

La orientación **sí cambia el nivel recibido**.

### Patrón direccional implementado

Según el error angular entre la Yagi y la estación:

  Diferencia de rumbo     Factor de señal
  --------------------- -----------------
  0--30°                            ×1.65
  30--60°                           ×1.15
  60--100°                          ×0.72
  100--140°                         ×0.50
  \>140°                            ×0.38

Por ejemplo, si una estación se encuentra aproximadamente a 45° desde su
locator y la antena apunta a 45°, obtiene una ganancia considerable.

Si gira la Yagi aproximadamente 180° respecto de esa estación, la señal
puede caer a cerca del **38 % del factor omnidireccional** dentro del
modelo.

No es solamente una animación visual.

------------------------------------------------------------------------

## ANT 2 --- ¼ λ Vertical

La vertical se comporta como la referencia omnidireccional del sistema:

**factor de antena = 1.0**

No necesita rotor.

Por eso el control de rotor queda deshabilitado al seleccionar ANT 2.

La vertical es útil para recorrer la banda sin preocuparse por
orientación y para comparar directamente el efecto de la Yagi.

------------------------------------------------------------------------

# Rotor

El rotor tiene movimiento simulado, no un salto instantáneo.

Al seleccionar un nuevo azimut:

1.  se establece un rumbo objetivo;
2.  la antena comienza a girar;
3.  el indicador muestra **ROTATING...**;
4.  el azimut real cambia progresivamente;
5.  al alcanzar el objetivo muestra **READY**.

La recepción utiliza el **azimut real durante el movimiento**, no
solamente el valor final solicitado.

Por lo tanto, una estación puede subir o bajar gradualmente mientras la
antena gira.

### Importante

Actualmente el sistema **calcula automáticamente el bearing**, pero **no
gira automáticamente la antena hacia la estación**.

El operador sigue manejando el rotor, como en una estación real.

------------------------------------------------------------------------

# Distancia

Además de utilizarse para calcular el bearing, la distancia introduce
una modificación deliberadamente suave:

-   menos de 80 km: pequeña reducción;
-   80--400 km: prácticamente neutra;
-   400--3500 km: pequeño refuerzo;
-   más de 9000 km: pequeña reducción.

No pretende reproducir saltos ionosféricos de manera determinista.

Una estación distante sigue pudiendo ser trabajada.

------------------------------------------------------------------------

# Potencia

La potencia de transmisión forma parte del estado distribuido por la
red.

El nivel recibido utiliza una relación logarítmica basada en la
potencia, por lo que pasar de 10 W a 100 W **no multiplica linealmente
por diez el volumen**.

Esto se aproxima mejor al comportamiento que esperamos de una señal de
radio.

La potencia interactúa con:

-   nivel base de banda;
-   distancia;
-   propagación;
-   orientación de antena;
-   filtro;
-   QSB.

------------------------------------------------------------------------

# Operadores virtuales e Inteligencia Artificial

Una de las funciones centrales de CW Network Radio es mantener una banda
útil incluso cuando todavía hay pocos operadores humanos conectados.

Los operadores virtuales no son simples grabaciones.

Pueden:

-   permanecer escuchando;
-   llamar CQ;
-   esperar respuestas;
-   buscar estaciones que llaman CQ;
-   desplazarse a otra frecuencia;
-   contestar a humanos;
-   realizar QSOs entre ellos;
-   continuar o cerrar un intercambio;
-   adoptar diferentes estilos operativos.

------------------------------------------------------------------------

## Personalidades

Actualmente existen perfiles como:

### SKCC

-   aproximadamente 11--16 WPM;
-   estilo tranquilo y tradicional;
-   llave recta como personalidad operativa.

### BUG

-   aproximadamente 15--20 WPM;
-   estilo conversacional;
-   personalidad de operador de bug.

### DX

-   aproximadamente 22--30 WPM;
-   intercambios cortos;
-   operación más rápida.

### RAGCHEW

-   aproximadamente 16--22 WPM;
-   conversación más amistosa;
-   puede realizar preguntas breves.

### HUNTER

-   aproximadamente 18--25 WPM;
-   busca actividad;
-   responde CQs con mayor iniciativa.

------------------------------------------------------------------------

# ¿Dónde entra la IA?

CW Network utiliza un pequeño modelo de lenguaje local:

**SmolLM2-135M-Instruct --- ONNX Q4**

El modelo tiene alrededor de 135 millones de parámetros y su versión
cuantizada es suficientemente pequeña como para experimentar con
inferencia del lado del servidor sin depender de una API comercial por
cada QSO.

La IA **no controla la radio**.

Esto es deliberado.

El servidor determinista controla:

-   quién está transmitiendo;
-   frecuencia;
-   estados CQ / LISTEN / WAIT_REPLY / QSO;
-   ocupación;
-   keying;
-   temporización;
-   movimiento entre frecuencias;
-   inicio y cierre de sesiones.

El modelo se utiliza para generar el **contenido conversacional** de
determinadas respuestas.

De esta forma una alucinación del modelo no puede cambiar
arbitrariamente el estado de la red.

------------------------------------------------------------------------

# IA aislada del servidor de radio --- v0.25

Desde v0.25 la inferencia se ejecuta mediante un **worker separado**.

La razón es estabilidad.

Una generación de IA puede consumir CPU y memoria durante varios
segundos. El WebSocket, en cambio, necesita responder continuamente a
eventos de manipulación.

Por eso:

**Radio en tiempo real ≠ proceso de inferencia**

Si la IA está ocupada, tarda demasiado o falla:

-   la conexión WebSocket continúa;
-   el CW humano continúa;
-   los operadores virtuales continúan;
-   se utiliza una respuesta de fallback;
-   la banda no depende de que el LLM responda.

El objetivo es que la inteligencia mejore la experiencia sin convertirse
en un punto único de falla.

------------------------------------------------------------------------

# Fallback inteligente

Los operadores virtuales disponen de respuestas deterministas de
respaldo.

Por eso el sistema puede seguir realizando QSOs aunque:

-   el modelo todavía esté cargando;
-   Render esté bajo carga;
-   una inferencia exceda el tiempo permitido;
-   el modelo falle;
-   el worker de IA deba reiniciarse.

El fallback conserva información de personalidad, indicativos y etapa
del QSO.

------------------------------------------------------------------------

# Bot ↔ Bot: no hace falta decodificar Morse

Cuando dos operadores virtuales realizan un QSO, el servidor ya conoce
el texto que cada uno está transmitiendo.

Por eso **no vuelve a decodificar su propio Morse**.

La secuencia lógica conoce directamente:

1.  texto generado;
2.  conversión a eventos CW;
3.  transmisión;
4.  contexto entregado al siguiente operador.

Esto evita introducir errores artificiales de decoder dentro de
conversaciones generadas por el propio sistema.

------------------------------------------------------------------------

# Humanos ↔ operadores virtuales

Con un humano la situación es diferente.

El servidor recibe el **timing real de la llave**, no el texto escrito.

Por eso existe un decoder adaptativo del lado del servidor.

El decoder:

-   parte del WPM declarado como referencia;
-   observa las duraciones reales de las marcas;
-   estima progresivamente la unidad Morse;
-   diferencia dit/dah;
-   detecta espacios entre caracteres y palabras;
-   intenta adaptarse a una llave recta imperfecta.

El decoder no tiene que ser un lector perfecto de CW para que la radio
funcione, pero permite que los operadores virtuales comprendan llamadas
CQ y participen en un QSO humano.

------------------------------------------------------------------------

# Actividad automática de banda

El servidor contiene un **Traffic Director**.

Su función no es transmitir continuamente, sino evitar que una banda
parezca muerta.

Puede:

-   hacer que una estación llame CQ;
-   colocarla en WAIT_REPLY;
-   hacer que un HUNTER encuentre el CQ;
-   iniciar un QSO bot↔bot;
-   dejar silencios;
-   cambiar una estación de frecuencia;
-   ajustar la población según usuarios humanos presentes.

La actividad se adapta a la ocupación.

El objetivo es crear la impresión de una banda que **existe
independientemente del usuario**, no un juego que comienza únicamente
cuando el usuario presiona un botón.

------------------------------------------------------------------------

# Indicativos virtuales

Los operadores virtuales reciben indicativos dinámicos dentro de una
familia ficticia de CW Network.

Se regeneran al iniciar el servidor y no pretenden representar
operadores de radio reales.

Esto permite que la población cambie entre sesiones y evita que la banda
parezca formada siempre por los mismos personajes.

------------------------------------------------------------------------

# Servicio CW Network

Cada banda dispone además de una estación de servicio **CWN** en una
frecuencia fija.

El servicio puede transmitir información de red/condiciones y funciona
como una referencia audible dentro del propio medio CW.

Frecuencias actuales:

  Banda          Servicio
  ------- ---------------
  80 m       3.551500 MHz
  40 m       7.031500 MHz
  20 m      14.026500 MHz
  15 m      21.026500 MHz
  10 m      28.021500 MHz

------------------------------------------------------------------------

# Arquitectura

``` text
┌──────────────────── Browser ────────────────────┐
│                                                 │
│  VFO / keyer / audio / filters / noise / QSB   │
│  waterfall / rotor / antenna / decoder visual  │
│                     │                           │
└─────────────────────┼───────────────────────────┘
                      │ WebSocket
                      ▼
┌──────────── CW Network Server ──────────────────┐
│                                                │
│ human key events                               │
│ station states                                 │
│ band routing                                   │
│ Traffic Director                               │
│ virtual operators                              │
│ server-side human CW decoder                   │
│ propagation / presence / service               │
│                     │                          │
└─────────────────────┼──────────────────────────┘
                      │ IPC
                      ▼
             ┌──────────────────┐
             │    AI Worker     │
             │                  │
             │ SmolLM2 135M Q4  │
             │ dialogue only    │
             └──────────────────┘
```

------------------------------------------------------------------------

# WebSocket y estabilidad

A partir de v0.25 los eventos de CW se distribuyen **por banda**.

Un usuario escuchando 40 m no necesita recibir cada dit y dah generado
simultáneamente en 80, 20, 15 y 10 m.

Esto reduce significativamente:

-   mensajes WebSocket;
-   procesamiento del navegador;
-   actualizaciones de audio innecesarias;
-   carga causada por operadores virtuales.

Los estados generales, condiciones y presencia pueden seguir
distribuyéndose globalmente cuando corresponde.

La conexión también utiliza heartbeat y reconexión automática.

------------------------------------------------------------------------

# Audio

El servidor **no transmite audio**.

El servidor distribuye eventos y estados objetivos.

Cada navegador sintetiza localmente:

-   tono CW;
-   diferencia de tono por desintonía;
-   volumen de cada estación;
-   ruido;
-   QRN;
-   QSB;
-   filtro;
-   efecto de antena;
-   efecto de propagación.

Esto reduce muchísimo el ancho de banda y permite que varias estaciones
puedan escucharse simultáneamente como señales independientes.

------------------------------------------------------------------------

# QRM

Si varias estaciones transmiten próximas en frecuencia, el navegador
puede generar varias voces CW simultáneamente.

Por eso el QRM surge de la propia actividad de red en lugar de
reproducirse como una grabación artificial.

El filtro y la sintonía determinan cuáles entran en la ventana de
recepción.

------------------------------------------------------------------------

# Break-in

La radio incluye:

### QSK

Retorno prácticamente inmediato a recepción.

### SEMI

Retorno después del delay configurado.

### OFF

Simula una retención más larga antes de volver a recepción.

No existe un transmisor físico ni un relay real, por lo que estas
funciones representan el comportamiento operativo, no un circuito de
conmutación RF.

------------------------------------------------------------------------

# Waterfall

El waterfall representa actividad de las estaciones que realmente están
transmitiendo en la red.

También sirve para sintonizar:

-   haga clic sobre una señal;
-   el VFO se desplaza a esa zona;
-   ajuste finamente si es necesario.

La marca central indica la posición actual de recepción.

------------------------------------------------------------------------

# DATA / decoder

La interfaz incorpora un decoder visual opcional.

Su propósito principal es asistir durante la escucha y proporcionar
información sobre lo que el receptor está interpretando.

No sustituye la práctica auditiva de CW y puede cometer errores,
especialmente con:

-   llave recta irregular;
-   QRM;
-   señales fuera de sintonía;
-   velocidades variables.

------------------------------------------------------------------------

# Condiciones de señal: resumen

De forma simplificada, la señal recibida se construye a partir de:

``` text
Nivel base de banda
        ×
Potencia TX
        ×
Factor de antena
        ×
Factor de propagación
        ×
Respuesta del filtro/sintonía
        ×
QSB
```

A esto se suma el ambiente independiente de:

``` text
Ruido de banda + QRN
```

NB y NR modifican esos componentes de ruido.

------------------------------------------------------------------------

# Ejemplo práctico con rotor

Supongamos:

-   usted está en **GG14**;
-   otra estación tiene un locator válido;
-   selecciona **ANT 1 · 3EL YAGI**.

CW Network calcula automáticamente el bearing entre ambos locators.

Si el resultado fuese, por ejemplo, **070°**:

1.  mueva el rotor hacia 070°;
2.  observe cómo cambia el azimut real mientras gira;
3.  la señal debería aumentar al entrar aproximadamente dentro de ±60°;
4.  dentro de ±30° se aplica la máxima ganancia direccional del modelo;
5.  gire hacia la dirección opuesta y podrá comprobar la atenuación
    trasera.

Con **ANT 2 · ¼λ VERTICAL**, ese efecto desaparece y el factor vuelve a
ser omnidireccional.

------------------------------------------------------------------------

# Qué intenta simular y qué no

## Sí intenta simular

-   operación de VFO;
-   sintonía;
-   filtros;
-   offset de tono;
-   QRM real entre usuarios;
-   ruido diferente por banda;
-   QRN;
-   QSB;
-   potencia;
-   antena vertical;
-   Yagi y rotor;
-   rumbo derivado de Maidenhead;
-   distancia;
-   influencia moderada de Kp/SFI;
-   estilos diferentes de operador;
-   actividad espontánea;
-   tráfico CW real entre navegadores.

## No intenta ser

-   un motor profesional de predicción VOACAP;
-   un cálculo científico completo de ionosfera;
-   un SDR remoto;
-   una simulación eléctrica exacta de un transceptor específico;
-   un sistema donde una mala propagación haga imposible utilizar la
    plataforma.

------------------------------------------------------------------------

# Estado de la IA

El endpoint del backend permite comprobar el estado del sistema.

En v0.25 puede informar estados como:

``` json
{
  "ai": "LOADING",
  "aiBusy": false,
  "aiReadyAt": null,
  "aiError": null
}
```

### `LOADING`

El modelo está siendo cargado.

### `READY`

El modelo está disponible para generar diálogo.

### `FALLBACK`

La radio continúa funcionando, pero las respuestas utilizan el motor
determinista de respaldo.

### `aiBusy`

Indica que el worker está procesando una generación.

La IA es una mejora de conversación, **no una dependencia necesaria para
mantener la radio en línea**.

------------------------------------------------------------------------

# Stack

## Frontend

-   HTML
-   CSS
-   JavaScript
-   Web Audio API
-   WebSocket
-   GitHub Pages

## Backend

-   Node.js 20+
-   `ws`
-   WebSocket
-   Render

## IA

-   Transformers.js
-   ONNX
-   SmolLM2-135M-Instruct cuantizado
-   worker/proceso independiente

## Datos externos

-   NOAA Space Weather Prediction Center para Kp y Solar Flux.

------------------------------------------------------------------------

# Estructura básica

``` text
CW-Network/
├── index.html
├── radio.js
├── server.js
├── ai-worker.js
├── package.json
└── README.md
```

------------------------------------------------------------------------

# Ejecutar el backend

Requiere Node.js 20 o superior.

``` bash
npm install
npm start
```

El frontend debe apuntar al WebSocket del backend mediante:

``` html
<meta name="cw-ws-url" content="wss://cw-network.onrender.com">
```

Para un despliegue propio puede cambiarse esa dirección por el servidor
correspondiente.

------------------------------------------------------------------------

# Despliegue actual

## Frontend

GitHub Pages:

**https://zp5dxs.github.io/CW-Network/**

## Backend

Render:

**https://cw-network.onrender.com**

------------------------------------------------------------------------

# Otros proyectos relacionados

## Morse Practice

Entrenador CW gratuito desarrollado por ZP5DXS:

**https://zp5dxs.github.io/morse-practice/**

## CW-LATAM Radar

Radar de actividad CW orientado a Sudamérica:

**https://zp5dxs.github.io/CW-LATAM/**

------------------------------------------------------------------------

# Filosofía de desarrollo

CW Network Radio prioriza cuatro cosas:

1.  **La manipulación humana debe seguir siendo humana.**\
    La red transporta el timing del operador, no una versión perfecta
    reconstruida de su texto.

2.  **La radio debe sentirse viva.**\
    Puede haber actividad aunque el usuario recién llegue.

3.  **La propagación debe aportar carácter, no frustración.**\
    Las condiciones afectan la experiencia sin convertirla en una
    lotería de "puede/no puede".

4.  **La IA nunca debe comprometer el tiempo real.**\
    El WebSocket y la manipulación tienen prioridad absoluta sobre la
    generación de lenguaje.

------------------------------------------------------------------------

# Roadmap

El desarrollo continúa especialmente en:

-   comportamiento más natural de operadores virtuales;
-   mejor adaptación a puños de llave recta;
-   mayor variedad de QSOs;
-   comportamiento específico por banda;
-   timing humano diferenciado entre straight key, bug y paddle;
-   RST más dependiente de señal;
-   pileups y escenarios DX;
-   QRS, QRZ, AGN y respuestas ante recepción incompleta;
-   memoria corta de QSO para reducir repeticiones;
-   optimización continua de estabilidad y latencia de IA.

------------------------------------------------------------------------

# Autor

**Mathias Maidana --- ZP5DXS**

CW Network Radio nace como un experimento para unir práctica de
telegrafía, operación de radio, propagación simplificada y una red
mundial de operadores humanos y virtuales en una misma experiencia.

**73 de ZP5DXS**
