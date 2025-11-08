
const TelegramBot = require('node-telegram-bot-api');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');

// Configuration
const CONFIG = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    STREAM_URL: 'http://g.rosexz.xyz/at/sh/805768?token=SxAKVEBaQ14XUwYBBVYCD1VdBQRSB1cABAAEUVoFBw4JC1ADBQZUAVQTHBNGEEFcBQhpWAASCFcBAABTFUQTR0NXEGpaVkNeFwUHBgxVBAxGSRRFDV1XQA8ABlQKUFcFCAdXGRFCCAAXC15EWQgfGwEdQlQWXlMOalVUElAFAxQKXBdZXx5DC1tuVFRYBV1dRl8UAEYcEAtGQRNeVxMKWhwQAFxHQAAQUBMKX0AIXxVGBllECkRAGxcLEy1oREoUVUoWUF1BCAtbEwoTQRcRFUYMRW4WVUEWR1RQCVwURAwSAkAZEV8AHGpSX19bAVBNDQpYQkYKEFMXHRMJVggPQl9APUVaVkNeW0RcXUg',
    WATERMARK_TEXT: 't.me/xl9rr',
    SEGMENT_DURATION: 17,
    MAX_DURATION: 40,
    TEMP_DIR: './temp',
    PORT: process.env.PORT || 3000,
    MAX_CHUNK_SIZE: 5 * 1024 * 1024, // 5MB chunks max
    BUFFER_HIGH_WATER_MARK: 512 * 1024 // 512KB buffer
};

if (!CONFIG.BOT_TOKEN) {
    console.error('[ERROR] BOT_TOKEN not found');
    process.exit(1);
}

// Bot state - تقليل استخدام الذاكرة
const state = {
    isRecording: false,
    users: new Set(),
    currentRecorder: null,
    segmentCount: 0,
    pendingSends: 0
};

const bot = new TelegramBot(CONFIG.BOT_TOKEN, { 
    polling: true,
    filepath: false // تقليل الذاكرة
});

// Create temp directory
function initTempDir() {
    if (!fs.existsSync(CONFIG.TEMP_DIR)) {
        fs.mkdirSync(CONFIG.TEMP_DIR, { recursive: true });
    } else {
        const files = fs.readdirSync(CONFIG.TEMP_DIR);
        files.forEach(file => {
            try {
                fs.unlinkSync(path.join(CONFIG.TEMP_DIR, file));
            } catch (err) {}
        });
    }
}

// Create scrolling watermark - مُحسّن
function createScrollingWatermark() {
    return [
        {
            filter: 'drawtext',
            options: {
                text: CONFIG.WATERMARK_TEXT,
                fontsize: 30,
                fontcolor: 'white@0.85',
                shadowcolor: 'black@0.3',
                shadowx: 1,
                shadowy: 1,
                y: 'h-th-40',
                x: 'w - mod(t*120, w+tw)'
            }
        }
    ];
}

// 🚀 تسجيل مقطع بأقل ذاكرة ممكنة
function recordSegmentOptimized(segmentNum, startTime) {
    return new Promise((resolve, reject) => {
        const outputStream = new PassThrough({ 
            highWaterMark: CONFIG.BUFFER_HIGH_WATER_MARK 
        });
        
        const chunks = [];
        let totalSize = 0;
        let completed = false;
        let timeoutId = null;
        const endTime = startTime + CONFIG.SEGMENT_DURATION;

        console.log(`[STREAM] #${segmentNum} [${startTime}ث → ${endTime}ث]`);

        timeoutId = setTimeout(() => {
            if (!completed) {
                console.log(`\n[TIMEOUT] #${segmentNum}`);
                cleanup();
                if (chunks.length > 0) {
                    resolveWithBuffer();
                } else {
                    reject(new Error('TIMEOUT_NO_DATA'));
                }
            }
        }, 18000);

        const cleanup = () => {
            completed = true;
            if (timeoutId) clearTimeout(timeoutId);
            outputStream.removeAllListeners();
            outputStream.destroy();
        };

        const resolveWithBuffer = () => {
            if (chunks.length === 0) {
                reject(new Error('NO_DATA'));
                return;
            }
            
            const buffer = Buffer.concat(chunks);
            const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
            console.log(`[BUFFER] #${segmentNum}: ${sizeMB}MB`);
            
            // تحرير الذاكرة فوراً
            chunks.length = 0;
            chunks.splice(0);
            
            resolve({
                buffer: buffer,
                segmentNum: segmentNum,
                startTime: startTime,
                endTime: endTime,
                size: buffer.length
            });
        };

        const recorder = ffmpeg(CONFIG.STREAM_URL)
            .inputOptions([
                '-t', CONFIG.SEGMENT_DURATION.toString(),
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5',
                '-reconnect_at_eof', '1',
                '-timeout', '8000000',
                '-analyzeduration', '1000000',
                '-probesize', '1000000',
                '-fflags', '+discardcorrupt+nobuffer',
                '-flags', 'low_delay'
            ])
            .videoFilters(createScrollingWatermark())
            .outputOptions([
                '-c:v', 'libx264',
                '-preset', 'veryfast', // أسرع من ultrafast مع جودة أفضل
                '-crf', '23',
                '-tune', 'zerolatency',
                '-profile:v', 'baseline',
                '-level', '3.0',
                '-c:a', 'aac',
                '-b:a', '96k',
                '-ar', '44100',
                '-ac', '2',
                '-movflags', '+frag_keyframe+empty_moov+default_base_moof+faststart',
                '-threads', '1',
                '-f', 'mp4',
                '-max_muxing_queue_size', '512',
                '-avoid_negative_ts', 'make_zero',
                '-fflags', '+genpts'
            ])
            .on('start', () => {
                console.log(`[START] #${segmentNum}`);
            })
            .on('progress', (progress) => {
                if (progress.timemark) {
                    process.stdout.write(`\r[⏱️] #${segmentNum}: ${progress.timemark}`);
                }
            })
            .on('error', (err) => {
                if (!completed) {
                    console.error(`\n[ERROR] #${segmentNum}: ${err.message}`);
                    cleanup();
                    
                    if (chunks.length > 0) {
                        resolveWithBuffer();
                    } else {
                        reject(err);
                    }
                }
            })
            .on('end', () => {
                if (!completed) {
                    console.log(`\n[✓] #${segmentNum} done`);
                    cleanup();
                    resolveWithBuffer();
                }
            });

        // جمع البيانات بحد أقصى
        outputStream.on('data', (chunk) => {
            if (!completed) {
                chunks.push(chunk);
                totalSize += chunk.length;

                // حماية من تجاوز الذاكرة
                if (totalSize > 80 * 1024 * 1024) {
                    console.log(`\n[WARN] #${segmentNum} too large`);
                    cleanup();
                    reject(new Error('BUFFER_OVERFLOW'));
                }
            }
        });

        outputStream.on('error', (err) => {
            if (!completed) {
                console.error(`\n[STREAM ERROR] #${segmentNum}`);
                cleanup();
                if (chunks.length > 0) {
                    resolveWithBuffer();
                } else {
                    reject(err);
                }
            }
        });

        try {
            recorder.pipe(outputStream, { end: true });
            state.currentRecorder = recorder;
        } catch (err) {
            cleanup();
            reject(err);
        }
    });
}

// 🚀 إرسال المقطع بأقل ذاكرة
async function sendSegmentOptimized(segmentData) {
    const { buffer, segmentNum, startTime, endTime, size } = segmentData;
    const sizeMB = (size / 1024 / 1024).toFixed(2);

    console.log(`\n[SEND] #${segmentNum} [${startTime}ث → ${endTime}ث] - ${sizeMB}MB`);

    if (state.users.size === 0) {
        console.log('[WARN] لا يوجد مستخدمين');
        buffer.fill(0);
        return;
    }

    state.pendingSends++;
    let successCount = 0;
    let failCount = 0;

    for (const userId of state.users) {
        try {
            const bufferStream = new PassThrough({ 
                highWaterMark: CONFIG.BUFFER_HIGH_WATER_MARK 
            });
            bufferStream.end(buffer);

            await bot.sendVideo(userId, bufferStream, {
                caption: 
                    `🎬 #${segmentNum}\n` +
                    `⏱️ [${startTime}ث → ${endTime}ث]\n` +
                    `💾 ${sizeMB}MB`,
                supports_streaming: true
            }, {
                contentType: 'video/mp4',
                filename: `seg_${segmentNum}.mp4`
            });

            successCount++;
            console.log(`[OK] ✅ ${userId}`);
        } catch (error) {
            failCount++;
            console.error(`[FAIL] ❌ ${userId}`);
        }
    }

    console.log(`[RESULT] ✅ ${successCount} | ❌ ${failCount}`);

    // تحرير الذاكرة فوراً
    buffer.fill(0);
    state.pendingSends--;
    
    // تشغيل garbage collection إذا متاح
    if (global.gc && state.pendingSends === 0) {
        global.gc();
    }
}

// 🚀 حلقة التسجيل المتواصل - محسّنة للذاكرة
async function continuousRecordingLoop() {
    let currentTime = 0;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 5;

    while (state.isRecording) {
        let segmentData = null;
        
        try {
            state.segmentCount++;
            const segmentNum = state.segmentCount;

            console.log(`\n${'='.repeat(60)}`);
            console.log(`⏺️ تسجيل #${segmentNum} [${currentTime}ث → ${currentTime + CONFIG.SEGMENT_DURATION}ث]`);
            console.log(`${'='.repeat(60)}\n`);

            // تسجيل المقطع
            segmentData = await recordSegmentOptimized(segmentNum, currentTime);

            // نجح التسجيل
            consecutiveErrors = 0;

            // إرسال المقطع فوراً (لا ننتظر)
            if (state.isRecording && state.users.size > 0) {
                sendSegmentOptimized(segmentData).catch(err => {
                    console.error(`[SEND ERROR] #${segmentNum}`);
                });
            } else {
                // تحرير الذاكرة
                if (segmentData && segmentData.buffer) {
                    segmentData.buffer.fill(0);
                }
            }

            // تحديث الوقت للمقطع التالي - بدون فجوات
            currentTime += CONFIG.SEGMENT_DURATION;

            // تنظيف الذاكرة كل 2 مقاطع
            if (global.gc && segmentNum % 2 === 0) {
                global.gc();
                const memUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
                console.log(`[MEM] ${memUsage}MB / 512MB`);
            }

            // إزالة المرجع
            segmentData = null;

        } catch (error) {
            consecutiveErrors++;
            console.error(`[ERROR ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}] ${error.message}`);

            // تحرير الذاكرة في حالة الخطأ
            if (segmentData && segmentData.buffer) {
                segmentData.buffer.fill(0);
            }
            segmentData = null;

            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                console.error('[CRITICAL] Too many errors, stopping...');
                state.isRecording = false;
                break;
            }

            const waitTime = Math.min(1500 * consecutiveErrors, 8000);
            console.log(`[RETRY] Waiting ${waitTime/1000}s...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));

            if (global.gc) global.gc();
        }
    }

    console.log('[STOP] Recording loop stopped');
    if (global.gc) global.gc();
}

// Start recording
function startRecording() {
    if (state.isRecording) return false;

    state.isRecording = true;
    state.segmentCount = 0;
    state.pendingSends = 0;
    console.log('[START] 🎬 تسجيل متواصل بدون انقطاع');

    if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
    }

    continuousRecordingLoop().catch(err => {
        console.error(`[FATAL] ${err.message}`);
        stopRecording();
    });

    return true;
}

// Stop recording
function stopRecording() {
    state.isRecording = false;

    if (state.currentRecorder) {
        state.currentRecorder.kill('SIGKILL');
        state.currentRecorder = null;
    }

    console.log('[STOP] Recording stopped');
    resetInactivityTimer();

    if (global.gc) {
        global.gc();
    }

    return true;
}

// ========================================
// Telegram Bot Commands
// ========================================

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    state.users.add(chatId);

    const keyboard = {
        inline_keyboard: [
            [
                { text: '🔴 تشغيل', callback_data: 'start_rec' },
                { text: '⏹️ إيقاف', callback_data: 'stop_rec' }
            ],
            [
                { text: '📊 الحالة', callback_data: 'status' },
                { text: '⚙️ الإعدادات', callback_data: 'settings' }
            ],
            [{ text: '❓ المساعدة', callback_data: 'help' }]
        ]
    };

    bot.sendMessage(chatId, 
        `🎬 *بوت تسجيل البث المباشر*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `✨ *المميزات:*\n` +
        `• 🎯 تسجيل متواصل بدون فقدان ثواني\n` +
        `• 🎥 جودة عالية (CRF 23)\n` +
        `• 💫 علامة مائية متحركة\n` +
        `• ⚡ إرسال تلقائي فوري\n` +
        `• 💾 استهلاك ذاكرة منخفض جداً\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📊 كل مقطع ${CONFIG.SEGMENT_DURATION} ثانية\n` +
        `⏺️ #1 [0→${CONFIG.SEGMENT_DURATION}] → #2 [${CONFIG.SEGMENT_DURATION}→${CONFIG.SEGMENT_DURATION*2}] → #3 [${CONFIG.SEGMENT_DURATION*2}→${CONFIG.SEGMENT_DURATION*3}]\n\n` +
        `🚀 جاهز للتسجيل!`,
        { reply_markup: keyboard, parse_mode: 'Markdown' }
    );
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;

    await bot.answerCallbackQuery(query.id);

    switch (query.data) {
        case 'start_rec':
            if (startRecording()) {
                bot.sendMessage(chatId, 
                    `✅ *تم بدء التسجيل المتواصل!*\n\n` +
                    `⏱️ المدة: ${CONFIG.SEGMENT_DURATION}ث لكل مقطع\n` +
                    `💧 العلامة: ${CONFIG.WATERMARK_TEXT}\n` +
                    `🎯 تسجيل متواصل بدون انقطاع\n\n` +
                    `⏺️ #1 [0→${CONFIG.SEGMENT_DURATION}]\n` +
                    `⏺️ #2 [${CONFIG.SEGMENT_DURATION}→${CONFIG.SEGMENT_DURATION*2}]\n` +
                    `⏺️ #3 [${CONFIG.SEGMENT_DURATION*2}→${CONFIG.SEGMENT_DURATION*3}]\n` +
                    `...وهكذا`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                bot.sendMessage(chatId, '⚠️ التسجيل يعمل بالفعل!');
            }
            break;

        case 'stop_rec':
            if (stopRecording()) {
                bot.sendMessage(chatId, 
                    `⏹️ *تم إيقاف التسجيل*\n\n` +
                    `📊 إجمالي المقاطع: ${state.segmentCount}\n` +
                    `⏱️ إجمالي الوقت: ${state.segmentCount * CONFIG.SEGMENT_DURATION}ث`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                bot.sendMessage(chatId, '⚠️ التسجيل متوقف بالفعل');
            }
            break;

        case 'status':
            const status = state.isRecording ? '🔴 يعمل' : '⚪ متوقف';
            const memory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
            const totalTime = state.segmentCount * CONFIG.SEGMENT_DURATION;

            bot.sendMessage(chatId,
                `📊 *حالة البوت*\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `الحالة: ${status}\n` +
                `المقاطع: ${state.segmentCount}\n` +
                `الوقت: ${totalTime}ث\n` +
                `المستخدمين: ${state.users.size}\n` +
                `الذاكرة: ${memory}MB / 512MB\n\n` +
                `⚙️ *الإعدادات:*\n` +
                `• المدة: ${CONFIG.SEGMENT_DURATION}ث\n` +
                `• العلامة: ${CONFIG.WATERMARK_TEXT}\n` +
                `• الوضع: متواصل بدون فجوات`,
                { parse_mode: 'Markdown' }
            );
            break;

        case 'settings':
            bot.sendMessage(chatId,
                `⚙️ *الإعدادات*\n\n` +
                `• \`/duration ${CONFIG.SEGMENT_DURATION}\` - تغيير المدة (5-${CONFIG.MAX_DURATION}ث)\n` +
                `• \`/watermark نص\` - تغيير العلامة\n\n` +
                `💡 أوقف التسجيل قبل التغيير`,
                { parse_mode: 'Markdown' }
            );
            break;

        case 'help':
            bot.sendMessage(chatId,
                `❓ *المساعدة*\n\n` +
                `*الأوامر:*\n` +
                `• \`/start\` - تشغيل البوت\n` +
                `• \`/duration <ث>\` - مدة المقطع\n` +
                `• \`/watermark <نص>\` - العلامة المائية\n` +
                `• \`/status\` - الحالة\n\n` +
                `*التسجيل المتواصل:*\n` +
                `⏺️ #1 [0→14] → #2 [14→28] → #3 [28→42]\n\n` +
                `بدون فقدان أي لحظة! 🎯`,
                { parse_mode: 'Markdown' }
            );
            break;
    }
});

bot.onText(/\/duration (\d+)/, (msg, match) => {
    if (state.isRecording) {
        bot.sendMessage(msg.chat.id, '⚠️ أوقف التسجيل أولاً!');
        return;
    }

    const duration = parseInt(match[1]);

    if (duration < 5 || duration > CONFIG.MAX_DURATION) {
        bot.sendMessage(msg.chat.id, `⚠️ المدة من 5 إلى ${CONFIG.MAX_DURATION}ث`);
        return;
    }

    CONFIG.SEGMENT_DURATION = duration;
    bot.sendMessage(msg.chat.id, 
        `✅ المدة: *${duration}ث*\n\n` +
        `⏺️ #1 [0→${duration}]\n` +
        `⏺️ #2 [${duration}→${duration*2}]\n` +
        `⏺️ #3 [${duration*2}→${duration*3}]`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/watermark (.+)/, (msg, match) => {
    if (state.isRecording) {
        bot.sendMessage(msg.chat.id, '⚠️ أوقف التسجيل أولاً!');
        return;
    }

    CONFIG.WATERMARK_TEXT = match[1].trim();
    bot.sendMessage(msg.chat.id, `✅ العلامة: \`${CONFIG.WATERMARK_TEXT}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, (msg) => {
    const status = state.isRecording ? '🔴 يعمل' : '⚪ متوقف';
    const memory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalTime = state.segmentCount * CONFIG.SEGMENT_DURATION;

    bot.sendMessage(msg.chat.id,
        `📊 ${status}\n` +
        `📹 ${state.segmentCount} مقاطع (${totalTime}ث)\n` +
        `💾 ${memory}MB / 512MB`,
        { parse_mode: 'Markdown' }
    );
});

// ========================================
// Start Bot
// ========================================

let inactivityTimer = null;
const INACTIVITY_TIMEOUT = 30 * 60 * 1000;

function resetInactivityTimer() {
    if (inactivityTimer) clearTimeout(inactivityTimer);

    if (!state.isRecording) {
        inactivityTimer = setTimeout(() => {
            console.log('[AUTO-STOP] 🌙 وضع السكون');
            if (global.gc) global.gc();
        }, INACTIVITY_TIMEOUT);
    }
}

async function main() {
    initTempDir();

    console.log('╔════════════════════════════════════════╗');
    console.log('║   Ultra Low Memory Recorder (512MB)  ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');
    console.log(`[OK] ✅ Bot ready`);
    console.log(`[MEM] ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB / 512MB`);
    console.log(`[DUR] ${CONFIG.SEGMENT_DURATION}s per segment`);
    console.log(`[WM] ${CONFIG.WATERMARK_TEXT}`);
    console.log(`[MODE] 🎯 Continuous (no gaps)`);
    console.log(`[PATTERN] #1[0→${CONFIG.SEGMENT_DURATION}] → #2[${CONFIG.SEGMENT_DURATION}→${CONFIG.SEGMENT_DURATION*2}] → #3[${CONFIG.SEGMENT_DURATION*2}→${CONFIG.SEGMENT_DURATION*3}]...`);
    console.log(`[OPT] Memory optimized for 512MB`);
    console.log('');

    resetInactivityTimer();

    const express = require('express');
    const app = express();

    app.get('/', (req, res) => {
        res.json({
            bot: 'Ultra Low Memory Recorder',
            status: 'online',
            recording: state.isRecording,
            segments: state.segmentCount,
            total_seconds: state.segmentCount * CONFIG.SEGMENT_DURATION,
            users: state.users.size,
            memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
            segment_duration: CONFIG.SEGMENT_DURATION + 's',
            mode: 'continuous (no gaps)',
            optimization: 'ultra low memory'
        });
    });

    app.get('/health', (req, res) => {
        res.json({ 
            status: 'healthy',
            memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
            uptime: process.uptime()
        });
    });

    app.listen(CONFIG.PORT, '0.0.0.0', () => {
        console.log(`[SERVER] Running on 0.0.0.0:${CONFIG.PORT}`);
    });
}

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT]', err.message);
    if (global.gc) global.gc();
});

process.on('unhandledRejection', (err) => {
    console.error('[UNHANDLED]', err.message);
    if (global.gc) global.gc();
});

process.on('SIGTERM', () => {
    console.log('\n[SHUTDOWN] SIGTERM');
    stopRecording();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] SIGINT');
    stopRecording();
    process.exit(0);
});

// تفعيل garbage collection تلقائياً
if (global.gc) {
    console.log('[MEM] ✅ Garbage collection enabled');
    setInterval(() => {
        if (!state.isRecording && state.pendingSends === 0) {
            global.gc();
        }
    }, 45000); // كل 45 ثانية
} else {
    console.log('[MEM] ⚠️ Run with --expose-gc for better memory');
}

main();
