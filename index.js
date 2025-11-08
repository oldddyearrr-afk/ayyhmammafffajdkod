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
    SEGMENT_DURATION: 14,
    MAX_DURATION: 40,
    TEMP_DIR: './temp',
    PORT: process.env.PORT || 3000
};

// Check for BOT_TOKEN
if (!CONFIG.BOT_TOKEN) {
    console.error('[ERROR] BOT_TOKEN not found in environment variables');
    console.error('[ERROR] Please add BOT_TOKEN in Secrets settings');
    process.exit(1);
}

// Bot state
const state = {
    isRecording: false,
    users: new Set(),
    currentRecorder: null,
    segmentCount: 0,
    recordingQueue: []
};

// Initialize Telegram bot
const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });

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

// Create scrolling watermark filter
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

// 🚀 تسجيل مقطع إلى الذاكرة مباشرة
function recordSegmentToMemory(segmentNum, startTime) {
    return new Promise((resolve, reject) => {
        const outputStream = new PassThrough();
        const chunks = [];
        let totalSize = 0;

        const endTime = startTime + CONFIG.SEGMENT_DURATION;
        console.log(`[STREAM] #${segmentNum} [${startTime}ث → ${endTime}ث]`);

        const recorder = ffmpeg(CONFIG.STREAM_URL)
            .inputOptions([
                '-t', CONFIG.SEGMENT_DURATION.toString(),
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5'
            ])
            .videoFilters(createScrollingWatermark())
            .outputOptions([
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', '23',
                '-c:a', 'aac',
                '-b:a', '96k',
                '-movflags', 'frag_keyframe+empty_moov+faststart',
                '-threads', '1',
                '-f', 'mp4'
            ])
            .on('start', () => {
                console.log(`[START] #${segmentNum} recording started`);
            })
            .on('progress', (progress) => {
                if (progress.timemark) {
                    process.stdout.write(`\r[PROGRESS] #${segmentNum}: ${progress.timemark}`);
                }
            })
            .on('error', (err) => {
                console.error(`\n[ERROR] #${segmentNum}: ${err.message}`);
                outputStream.end();
                reject(err);
            })
            .on('end', () => {
                console.log(`\n[DONE] #${segmentNum} recording completed`);
                outputStream.end();
            });

        // جمع البيانات
        outputStream.on('data', (chunk) => {
            chunks.push(chunk);
            totalSize += chunk.length;

            if (totalSize > 100 * 1024 * 1024) {
                console.log(`\n[WARN] #${segmentNum} buffer too large`);
                outputStream.removeAllListeners('data');
                reject(new Error('BUFFER_OVERFLOW'));
            }
        });

        outputStream.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
            console.log(`[BUFFER] #${segmentNum}: ${sizeMB}MB`);

            chunks.length = 0;

            resolve({
                buffer: buffer,
                segmentNum: segmentNum,
                startTime: startTime,
                endTime: endTime,
                size: buffer.length
            });
        });

        outputStream.on('error', reject);

        recorder.pipe(outputStream, { end: true });
        state.currentRecorder = recorder;
    });
}

// 🚀 إرسال المقطع للمستخدمين
async function sendSegmentToUsers(segmentData) {
    const { buffer, segmentNum, startTime, endTime, size } = segmentData;
    const sizeMB = (size / 1024 / 1024).toFixed(2);

    console.log(`\n[SEND] #${segmentNum} [${startTime}ث → ${endTime}ث] - ${sizeMB}MB`);

    if (state.users.size === 0) {
        console.log('[WARN] لا يوجد مستخدمين');
        buffer.fill(0);
        return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const userId of state.users) {
        try {
            const bufferStream = new PassThrough();
            bufferStream.end(buffer);

            await bot.sendVideo(userId, bufferStream, {
                caption: 
                    `🎬 *مقطع #${segmentNum}*\n\n` +
                    `⏱️ [${startTime}ث → ${endTime}ث]\n` +
                    `💾 ${sizeMB}MB\n` +
                    `📅 ${new Date().toLocaleString('ar-EG')}`,
                parse_mode: 'Markdown',
                supports_streaming: true
            });

            successCount++;
            console.log(`[OK] ✅ ${userId}`);
        } catch (error) {
            failCount++;
            console.error(`[FAIL] ❌ ${userId}: ${error.message}`);
        }
    }

    console.log(`[RESULT] ✅ ${successCount} | ❌ ${failCount}`);

    // تحرير الذاكرة فوراً
    buffer.fill(0);
}

// 🚀 حلقة التسجيل المتواصل (بدون فقدان ثواني)
async function continuousRecordingLoop() {
    let currentTime = 0;

    while (state.isRecording) {
        try {
            state.segmentCount++;
            const segmentNum = state.segmentCount;

            console.log(`\n${'='.repeat(60)}`);
            console.log(`⏺️ تسجيل #${segmentNum} [${currentTime}ث → ${currentTime + CONFIG.SEGMENT_DURATION}ث]`);
            console.log(`${'='.repeat(60)}\n`);

            // تسجيل المقطع
            const segmentData = await recordSegmentToMemory(segmentNum, currentTime);

            // إرسال المقطع فوراً (بينما المقطع التالي يبدأ التسجيل)
            if (state.isRecording && state.users.size > 0) {
                // نرسل في الخلفية بدون انتظار
                sendSegmentToUsers(segmentData).catch(err => {
                    console.error(`[SEND ERROR] #${segmentNum}: ${err.message}`);
                });
            } else {
                // تحرير الذاكرة إذا لم يكن هناك مستخدمين
                segmentData.buffer.fill(0);
            }

            // تحديث الوقت للمقطع التالي
            currentTime += CONFIG.SEGMENT_DURATION;

            // تحرير الذاكرة دورياً
            if (global.gc && segmentNum % 3 === 0) {
                global.gc();
                const memUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
                console.log(`[MEM] ${memUsage}MB / 512MB`);
            }

        } catch (error) {
            console.error(`[ERROR] ${error.message}`);

            // في حالة الخطأ، انتظر قليلاً قبل المحاولة مرة أخرى
            await new Promise(resolve => setTimeout(resolve, 2000));

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
    console.log('[START] 🎬 تسجيل متواصل بدون فقدان ثواني');

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
        `• 💾 استهلاك ذاكرة منخفض (512MB)\n\n` +
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
                    `⏱️ المدة: ${CONFIG.SEGMENT_DURATION} ثانية لكل مقطع\n` +
                    `💧 العلامة المائية: ${CONFIG.WATERMARK_TEXT}\n` +
                    `🎯 تسجيل متواصل بدون فقدان أي لحظة\n\n` +
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
                    `⏱️ إجمالي الوقت: ${state.segmentCount * CONFIG.SEGMENT_DURATION} ثانية`,
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
                `الوقت الكلي: ${totalTime}ث\n` +
                `المستخدمين: ${state.users.size}\n` +
                `الذاكرة: ${memory}MB / 512MB\n\n` +
                `⚙️ *الإعدادات:*\n` +
                `• المدة: ${CONFIG.SEGMENT_DURATION}ث\n` +
                `• العلامة: ${CONFIG.WATERMARK_TEXT}\n` +
                `• الوضع: تسجيل متواصل`,
                { parse_mode: 'Markdown' }
            );
            break;

        case 'settings':
            bot.sendMessage(chatId,
                `⚙️ *الإعدادات*\n\n` +
                `• \`/duration ${CONFIG.SEGMENT_DURATION}\` - تغيير المدة (5-${CONFIG.MAX_DURATION}ث)\n` +
                `• \`/watermark نص\` - تغيير العلامة المائية\n\n` +
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
        bot.sendMessage(msg.chat.id, `⚠️ المدة من 5 إلى ${CONFIG.MAX_DURATION} ثانية`);
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
            console.log('[AUTO-STOP] 🌙 وضع السكون بعد 30 دقيقة');
        }, INACTIVITY_TIMEOUT);
    }
}

async function main() {
    initTempDir();

    console.log('╔════════════════════════════════════════╗');
    console.log('║  Continuous Stream Recorder (512MB)  ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');
    console.log(`[OK] ✅ Bot ready`);
    console.log(`[MEM] ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB / 512MB`);
    console.log(`[DUR] ${CONFIG.SEGMENT_DURATION}s per segment`);
    console.log(`[WM] ${CONFIG.WATERMARK_TEXT}`);
    console.log(`[MODE] 🎯 Continuous recording (no gaps)`);
    console.log(`[PATTERN] #1[0→${CONFIG.SEGMENT_DURATION}] → #2[${CONFIG.SEGMENT_DURATION}→${CONFIG.SEGMENT_DURATION*2}] → #3[${CONFIG.SEGMENT_DURATION*2}→${CONFIG.SEGMENT_DURATION*3}]...`);
    console.log('');

    resetInactivityTimer();

    const express = require('express');
    const app = express();

    app.get('/', (req, res) => {
        res.json({
            bot: 'Continuous Stream Recorder',
            status: 'online',
            recording: state.isRecording,
            segments: state.segmentCount,
            total_seconds: state.segmentCount * CONFIG.SEGMENT_DURATION,
            users: state.users.size,
            memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
            segment_duration: CONFIG.SEGMENT_DURATION + 's',
            mode: 'continuous (no gaps)'
        });
    });

    app.get('/health', (req, res) => {
        res.json({ 
            status: 'healthy',
            memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
            uptime: process.uptime()
        });
    });

    app.listen(CONFIG.PORT, () => {
        console.log(`[SERVER] Running on port ${CONFIG.PORT}`);
    });
}

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT]', err);
});

process.on('unhandledRejection', (err) => {
    console.error('[UNHANDLED]', err);
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

// تفعيل garbage collection
if (global.gc) {
    console.log('[MEM] ✅ Garbage collection enabled');
    setInterval(() => {
        if (!state.isRecording) {
            global.gc();
        }
    }, 60000);
} else {
    console.log('[MEM] ⚠️ Run with --expose-gc for better memory');
}

main();
