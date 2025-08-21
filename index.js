const {
    Client,
    GatewayIntentBits,
    Partials,
    ChannelType,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    PermissionsBitField,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

// Definindo o client antes de usá-lo
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
});

// IDs do servidor
const GUILD_ID = '1403745828635414659';
const CANAL_PAINEL_ID = '1403762758931185747';
const CATEGORIA_PAGAMENTOS_ID = '1403834750568894626';
const REGISTRADO_ROLE_ID = '1403759346797514824';
const VIP_ROLE_ID = '1403759523663052821';
const AGUARDANDO_PAGAMENTO_ROLE_ID = '1403760210660687942';
const CANAL_REGISTRO_ID = '1403762565443489804';
const LOG_PAGAMENTOS_ID = '1403800340696137728';
const LOGS_BOTS_ID = '1403800395926474782';
const NOTIFICACOES_ID = '1403800130578284615';
const CANAL_WHATSAPP_ID = '1403800265953644544';
const EXCLUIDOS_ID = '1403800479250513992';
const LOG_COUPONS_ID = '1403800214242066493';
const CATEGORIA_EXPIRATIONS_ID = '1403837229247500380';

// Dados do PIX
const PIX_DATA = {
    chave: 'ghostdelay01@gmail.com',
    nome: 'Sebastião Vitor Santos da Silva',
};

// Conexão com MongoDB
const mongoUri = process.env.MONGO_URI;
const mongoClient = new MongoClient(mongoUri, {
    tls: true,
    tlsInsecure: process.env.MONGO_TLS_INSECURE === 'true',
    serverSelectionTimeoutMS: 10000,
    heartbeatFrequencyMS: 10000,
    connectTimeoutMS: 30000,
});
let db;

// Mapa para armazenar a relação _id -> userId
const userIdCache = new Map();

// Mapa para armazenar o intervalo global de verificação
const expirationCheckInterval = new Map();

// Inicialização das coleções
let registeredUsers, userBalances, paymentValues, activePixChannels, expirationDates, notificationSent, paymentHistory, couponUsage;

async function connectDB() {
    try {
        await mongoClient.connect();
        console.log('Conectado ao MongoDB');
        db = mongoClient.db('ghostdelay');
        return db;
    } catch (err) {
        console.error('Erro ao conectar ao MongoDB:', err);
        throw err;
    }
}

async function initializeCollections() {
    try {
        const db = await connectDB();
        registeredUsers = db.collection('registeredUsers');
        userBalances = db.collection('userBalances');
        paymentValues = db.collection('paymentValues');
        activePixChannels = db.collection('activePixChannels');
        expirationDates = db.collection('expirationDates');
        notificationSent = db.collection('notificationSent');
        paymentHistory = db.collection('paymentHistory');
        couponUsage = db.collection('couponUsage');

        console.log('Coleções inicializadas com sucesso');
        await setupChangeStream();
        await setupRegisteredUsersChangeStream();
    } catch (err) {
        console.error('Erro ao inicializar coleções:', err);
        setTimeout(initializeCollections, 5000); // Retry após 5 segundos
    }
}

async function setupChangeStream() {
    if (!expirationDates) {
        console.error('Coleção expirationDates não inicializada. Aguardando reinicialização...');
        return setTimeout(setupChangeStream, 5000);
    }

    try {
        const changeStream = expirationDates.watch([], { fullDocument: 'updateLookup' });
        console.log('Change Stream iniciado para expirationDates');

        changeStream.on('change', async (change) => {
            const documentKey = change.documentKey;
            if (!documentKey || !documentKey._id) {
                console.warn('Documento sem _id detectado no change stream de expirationDates:', change);
                return;
            }

            const docId = documentKey._id.toString();
            let userId;

            // Tentar obter userId diretamente do change stream
            if (change.fullDocument && change.fullDocument.userId) {
                userId = change.fullDocument.userId.toString();
                console.log(`userId extraído do fullDocument para _id ${docId}: ${userId}`);
                userIdCache.set(docId, userId);
            } else if (documentKey.userId) {
                userId = documentKey.userId.toString();
                console.log(`userId extraído do documentKey para _id ${docId}: ${userId}`);
                userIdCache.set(docId, userId);
            } else {
                // Para operações de delete, buscar userId na coleção registeredUsers
                try {
                    const registeredDoc = await registeredUsers.findOne(
                        { 'paymentHistory.expirationId': documentKey._id },
                        { projection: { userId: 1 } }
                    );
                    if (registeredDoc && registeredDoc.userId) {
                        userId = registeredDoc.userId.toString();
                        console.log(`userId recuperado de registeredUsers para _id ${docId}: ${userId}`);
                        userIdCache.set(docId, userId);
                    } else {
                        console.warn(`Nenhum userId encontrado para _id ${docId} em registeredUsers. Ação abortada.`);
                        return;
                    }
                } catch (err) {
                    console.error(`Erro ao buscar userId para _id ${docId} em expirationDates:`, err);
                    return;
                }
            }

            if (!userId) {
                console.warn(`Não foi possível determinar o userId para _id ${docId} em expirationDates. Ação abortada.`);
                return;
            }

            const guild = await client.guilds.fetch(GUILD_ID).catch(err => {
                console.error('Erro ao buscar guild:', err);
                return null;
            });
            if (!guild) return;

            const member = await guild.members.fetch(userId).catch(err => {
                console.error(`Erro ao buscar membro ${userId}:`, err);
                return null;
            });
            if (!member) return;

            const logsBotsChannel = await guild.channels.fetch(LOGS_BOTS_ID).catch(err => {
                console.error('Erro ao buscar canal de logs:', err);
                return null;
            });
            const notificacoesChannel = await guild.channels.fetch(NOTIFICACOES_ID).catch(err => {
                console.error('Erro ao buscar canal de notificações:', err);
                return null;
            });
            const excluidosChannel = await guild.channels.fetch(EXCLUIDOS_ID).catch(err => {
                console.error('Erro ao buscar canal de excluídos:', err);
                return null;
            });

            const horario = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false }).replace(', ', ' às ');

            if (change.operationType === 'delete') {
                console.log(`Assinatura cancelada para userId ${userId}`);
                try {
                    const botMember = await guild.members.fetch(client.user.id);
                    const botHighestRole = botMember.roles.highest;
                    const vipRole = await guild.roles.fetch(VIP_ROLE_ID);
                    const aguardandoRole = await guild.roles.fetch(AGUARDANDO_PAGAMENTO_ROLE_ID);

                    if (botHighestRole.position <= vipRole.position) {
                        console.error(`Bot não tem permissão para remover VIP (hierarquia insuficiente) para ${userId}`);
                    } else {
                        await member.roles.remove(VIP_ROLE_ID).catch(err => console.error(`Erro ao remover VIP para ${userId}:`, err));
                        console.log(`VIP removido para ${userId}`);
                    }

                    if (botHighestRole.position <= aguardandoRole.position) {
                        console.error(`Bot não tem permissão para adicionar AGUARDANDO_PAGAMENTO (hierarquia insuficiente) para ${userId}`);
                    } else {
                        await member.roles.add(AGUARDANDO_PAGAMENTO_ROLE_ID).catch(err => console.error(`Erro ao adicionar AGUARDANDO_PAGAMENTO para ${userId}:`, err));
                        console.log(`AGUARDANDO_PAGAMENTO adicionado para ${userId}`);
                    }

                    await notificationSent.deleteMany({ userId });

                    if (excluidosChannel) {
                        const embedExcluidos = new EmbedBuilder()
                            .setTitle('🚫 Assinatura Cancelada')
                            .setDescription(`A assinatura de <@${userId}> foi cancelada via painel.`)
                            .addFields([
                                { name: '👤 Usuário', value: `${member.user.tag}`, inline: false },
                                { name: '🆔 ID', value: userId, inline: true },
                                { name: '🕒 Horário', value: horario, inline: true },
                            ])
                            .setColor('#FF0000')
                            .setTimestamp();
                        await excluidosChannel.send({ embeds: [embedExcluidos] });
                        console.log(`Notificação enviada no canal EXCLUIDOS_ID para ${userId}`);
                    }

                    if (notificacoesChannel) {
                        const embedNotificacao = new EmbedBuilder()
                            .setTitle('🚫 Assinatura Cancelada')
                            .setDescription(`A assinatura de <@${userId}> foi cancelada.`)
                            .addFields([
                                { name: '👤 Usuário', value: `${member.user.tag}`, inline: false },
                                { name: '🆔 ID', value: userId, inline: true },
                                { name: '🕒 Horário', value: horario, inline: true },
                            ])
                            .setColor('#FF0000')
                            .setTimestamp();
                        await notificacoesChannel.send({ embeds: [embedNotificacao], content: `<@${userId}>` }).catch(err => {
                            console.error(`Falha ao enviar notificação de cancelamento para ${userId} no canal ${NOTIFICACOES_ID}:`, err);
                        });
                    }
                } catch (err) {
                    console.error(`Erro ao processar cancelamento para ${userId}:`, err);
                    if (logsBotsChannel) {
                        const errorEmbed = new EmbedBuilder()
                            .setTitle('⚠️ Erro ao Processar Cancelamento')
                            .setDescription(`Falha ao atualizar papéis após cancelamento para <@${userId}>.`)
                            .addFields([
                                { name: 'Usuário', value: `${member.user.tag} (ID: ${userId})`, inline: false },
                                { name: 'Erro', value: err.message, inline: false },
                            ])
                            .setColor('#FF0000')
                            .setTimestamp();
                        await logsBotsChannel.send({ embeds: [errorEmbed] });
                    }
                }
            } else if (change.operationType === 'insert' || change.operationType === 'update') {
                const fullDocument = change.fullDocument;
                if (!fullDocument || !fullDocument.expirationDate) {
                    console.warn('Documento sem expirationDate detectado:', change);
                    return;
                }

                const expirationDate = new Date(fullDocument.expirationDate);
                const now = new Date();
                console.log(`[${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}] Data de expiração alterada para ${userId}: ${expirationDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);

                try {
                    const botMember = await guild.members.fetch(client.user.id);
                    const botHighestRole = botMember.roles.highest;
                    const vipRole = await guild.roles.fetch(VIP_ROLE_ID);
                    const aguardandoRole = await guild.roles.fetch(AGUARDANDO_PAGAMENTO_ROLE_ID);

                    if (expirationDate > now) {
                        if (botHighestRole.position <= vipRole.position) {
                            console.error(`Bot não tem permissão para adicionar VIP (hierarquia insuficiente) para ${userId}`);
                        } else {
                            await member.roles.add(VIP_ROLE_ID).catch(err => console.error(`Erro ao adicionar VIP para ${userId}:`, err));
                            console.log(`VIP adicionado para ${userId}`);
                        }
                        if (botHighestRole.position <= aguardandoRole.position) {
                            console.error(`Bot não tem permissão para remover AGUARDANDO_PAGAMENTO (hierarquia insuficiente) para ${userId}`);
                        } else {
                            await member.roles.remove(AGUARDANDO_PAGAMENTO_ROLE_ID).catch(err => console.error(`Erro ao remover AGUARDANDO_PAGAMENTO para ${userId}:`, err));
                            console.log(`AGUARDANDO_PAGAMENTO removido para ${userId}`);
                        }
                    } else {
                        if (botHighestRole.position <= vipRole.position) {
                            console.error(`Bot não tem permissão para remover VIP (hierarquia insuficiente) para ${userId}`);
                        } else {
                            await member.roles.remove(VIP_ROLE_ID).catch(err => console.error(`Erro ao remover VIP para ${userId}:`, err));
                            console.log(`VIP removido para ${userId}`);
                        }
                        if (botHighestRole.position <= aguardandoRole.position) {
                            console.error(`Bot não tem permissão para adicionar AGUARDANDO_PAGAMENTO (hierarquia insuficiente) para ${userId}`);
                        } else {
                            await member.roles.add(AGUARDANDO_PAGAMENTO_ROLE_ID).catch(err => console.error(`Erro ao adicionar AGUARDANDO_PAGAMENTO para ${userId}:`, err));
                            console.log(`AGUARDANDO_PAGAMENTO adicionado para ${userId}`);
                        }
                    }

                    // Reinicia a verificação global para garantir que todas as expirações sejam monitoradas
                    await startExpirationCheck();
                } catch (err) {
                    console.error(`Erro ao atualizar papéis para ${userId}:`, err);
                    if (logsBotsChannel) {
                        const errorEmbed = new EmbedBuilder()
                            .setTitle('⚠️ Erro ao Atualizar Papéis')
                            .setDescription(`Falha ao atualizar papéis após alteração de expiração para <@${userId}>.`)
                            .addFields([
                                { name: 'Usuário', value: `${member.user.tag} (ID: ${userId})`, inline: false },
                                { name: 'Erro', value: err.message, inline: false },
                            ])
                            .setColor('#FF0000')
                            .setTimestamp();
                        await logsBotsChannel.send({ embeds: [errorEmbed] });
                    }
                }
            }
        });

        changeStream.on('error', (err) => {
            console.error('Erro no Change Stream:', err);
            setTimeout(setupChangeStream, 10000);
        });
    } catch (err) {
        console.error('Erro ao configurar Change Stream:', err);
        setTimeout(setupChangeStream, 10000);
    }
}

async function setupRegisteredUsersChangeStream() {
    if (!registeredUsers) {
        console.error('Coleção registeredUsers não inicializada. Aguardando reinicialização...');
        return setTimeout(setupRegisteredUsersChangeStream, 5000);
    }

    try {
        const changeStream = registeredUsers.watch([], { fullDocument: 'updateLookup' });
        console.log('Change Stream iniciado para registeredUsers');

        changeStream.on('change', async (change) => {
            const documentKey = change.documentKey;
            if (!documentKey || !documentKey._id) {
                console.warn('Documento sem _id detectado no change stream de registeredUsers:', change);
                return;
            }

            const docId = documentKey._id.toString();
            let userId;

            // Tentar obter userId diretamente do change stream
            if (change.fullDocument && change.fullDocument.userId) {
                userId = change.fullDocument.userId.toString();
                console.log(`userId extraído do fullDocument para _id ${docId}: ${userId}`);
                userIdCache.set(docId, userId);
            } else if (documentKey.userId) {
                userId = documentKey.userId.toString();
                console.log(`userId extraído do documentKey para _id ${docId}: ${userId}`);
                userIdCache.set(docId, userId);
            } else {
                // Para operações de delete, buscar userId no documento antes da exclusão
                try {
                    const doc = await registeredUsers.findOne(
                        { _id: new ObjectId(documentKey._id) },
                        { projection: { userId: 1 } }
                    );
                    if (doc && doc.userId) {
                        userId = doc.userId.toString();
                        console.log(`userId recuperado do documento para _id ${docId}: ${userId}`);
                        userIdCache.set(docId, userId);
                    } else {
                        // Fallback para cache
                        userId = userIdCache.get(docId);
                        if (userId) {
                            console.log(`userId recuperado do cache para _id ${docId}: ${userId}`);
                        } else {
                            console.warn(`Nenhum userId encontrado para _id ${docId} em registeredUsers ou cache. Ação abortada.`);
                            return;
                        }
                    }
                } catch (err) {
                    console.error(`Erro ao buscar userId para _id ${docId} em registeredUsers:`, err);
                    return;
                }
            }

            if (!userId) {
                console.warn(`Não foi possível determinar o userId para _id ${docId} em registeredUsers. Ação abortada.`);
                return;
            }

            const guild = await client.guilds.fetch(GUILD_ID).catch(err => {
                console.error('Erro ao buscar guild:', err);
                return null;
            });
            if (!guild) return;

            const member = await guild.members.fetch(userId).catch(err => {
                console.error(`Erro ao buscar membro ${userId}:`, err);
                return null;
            });
            if (!member) return;

            const whatsappChannel = await guild.channels.fetch(CANAL_WHATSAPP_ID).catch(err => {
                console.error('Erro ao buscar canal whatsapp:', err);
                return null;
            });
            const excluidosChannel = await guild.channels.fetch(EXCLUIDOS_ID).catch(err => {
                console.error('Erro ao buscar canal de excluídos:', err);
                return null;
            });

            const horario = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false }).replace(', ', ' às ');

            if (change.operationType === 'delete') {
                console.log(`Usuário excluído para userId ${userId}`);
                try {
                    const botMember = await guild.members.fetch(client.user.id);
                    const botHighestRole = botMember.roles.highest;
                    const rolesToRemove = [REGISTRADO_ROLE_ID, VIP_ROLE_ID, AGUARDANDO_PAGAMENTO_ROLE_ID];
            
                    for (const roleId of rolesToRemove) {
                        const role = await guild.roles.fetch(roleId).catch(err => null);
                        if (role && botHighestRole.position > role.position) {
                            await member.roles.remove(roleId).catch(err => console.error(`Erro ao remover cargo ${roleId} para ${userId}:`, err));
                            console.log(`Cargo ${roleId} removido para ${userId}`);
                        } else {
                            console.error(`Bot não tem permissão para remover ${roleId} (hierarquia insuficiente) para ${userId}`);
                        }
                    }
            
                    // Remover do cache
                    userIdCache.delete(docId);

                    // Limpar expirationDates e notificationSent
                    await expirationDates.deleteOne({ userId });
                    await notificationSent.deleteMany({ userId });
                } catch (err) {
                    console.error(`Erro ao remover cargos para ${userId}:`, err);
                    if (excluidosChannel) {
                        const errorEmbed = new EmbedBuilder()
                            .setTitle('⚠️ Erro ao Processar Exclusão')
                            .setDescription(`Falha ao remover cargos para <@${userId}> após exclusão.`)
                            .addFields([
                                { name: 'Usuário', value: `${member.user.tag} (ID: ${userId})`, inline: false },
                                { name: 'Erro', value: err.message, inline: false },
                            ])
                            .setColor('#FF0000')
                            .setTimestamp();
                        await excluidosChannel.send({ embeds: [errorEmbed] });
                    }
                }

                if (excluidosChannel) {
                    const embed = new EmbedBuilder()
                        .setTitle('🚫 Usuário Excluído')
                        .setDescription(`O usuário <@${userId}> foi excluído via painel e seus cargos foram removidos.`)
                        .addFields([
                            { name: '👤 Usuário', value: `${member.user.tag}`, inline: false },
                            { name: '🆔 ID', value: userId, inline: true },
                            { name: '🕒 Horário', value: horario, inline: true },
                        ])
                        .setColor('#FF0000')
                        .setTimestamp();
                    await excluidosChannel.send({ embeds: [embed] });
                }
            }
        });

        changeStream.on('error', (err) => {
            console.error('Erro no Change Stream de registeredUsers:', err);
            setTimeout(setupRegisteredUsersChangeStream, 10000);
        });
    } catch (err) {
        console.error('Erro ao configurar Change Stream de registeredUsers:', err);
        setTimeout(setupRegisteredUsersChangeStream, 10000);
    }
}

// Função auxiliar para calcular dias restantes
function calculateDaysLeft(expirationDate, now) {
    const expDate = new Date(expirationDate);
    if (isNaN(expDate.getTime())) return -1; // Data inválida
    const diffTime = expDate - now;
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// Função para verificar expirações de todos os usuários
async function checkAllExpirations() {
    try {
        if (!expirationDates) {
            console.error('Coleção expirationDates não disponível. Verificação cancelada.');
            return;
        }

        const now = new Date();
        const expirationDocs = await expirationDates.find({}).toArray();
        console.log(`Verificando ${expirationDocs.length} documentos de expiração às ${now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);

        if (expirationDocs.length === 0) {
            console.log('Nenhum documento em expirationDates. Verificação concluída.');
            return;
        }

        for (const doc of expirationDocs) {
            const { userId, expirationDate } = doc;
            if (!userId || !expirationDate) {
                console.warn(`Documento inválido encontrado: ${JSON.stringify(doc)}`);
                continue;
            }

            const daysLeft = calculateDaysLeft(expirationDate, now);
            if (daysLeft <= 3) {
                console.log(`Verificando expiração para userId ${userId}: ${daysLeft} dias restantes`);
                await checkExpirationNow(userId, expirationDate);
            }
        }
    } catch (err) {
        console.error('Erro ao verificar expirações:', err.message, err.stack);
    }
}

// Função para iniciar a verificação de expirações
async function startExpirationCheck() {
    // Cancelar qualquer intervalo existente
    if (expirationCheckInterval.size > 0) {
        const existingInterval = expirationCheckInterval.get('global');
        clearInterval(existingInterval);
        expirationCheckInterval.delete('global');
        console.log('Intervalo de verificação anterior cancelado');
    }

    // Iniciar um único intervalo global
    const interval = setInterval(async () => {
        console.log(`Iniciando verificação global de expirações às ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
        await checkAllExpirations();
    }, 3600 * 1000); // Intervalo de 1 hora

    expirationCheckInterval.set('global', interval);
    console.log('Intervalo de verificação global iniciado (1 hora)');

    // Executar a verificação imediatamente na inicialização
    await checkAllExpirations();
}

// Função auxiliar para verificar expiração imediatamente
async function checkExpirationNow(userId, expirationDate) {
    const now = new Date();
    const daysLeft = calculateDaysLeft(expirationDate, now);
    console.log(`[${new Date(now).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}] Verificando expiração para ${userId}: ${daysLeft} dias restantes`);

    const guild = await client.guilds.fetch(GUILD_ID).catch(err => {
        console.error('Erro ao buscar guild:', err);
        return null;
    });
    if (!guild) return;

    const member = await guild.members.fetch(userId).catch(err => {
        console.warn(`Usuário ${userId} não encontrado no servidor. Removendo dados de expiração. Erro: ${err.message}`);
        // Remover dados de expiração e notificação para usuários ausentes
        expirationDates.deleteOne({ userId }).catch(err => console.error(`Erro ao remover expiração para ${userId}:`, err));
        notificationSent.deleteMany({ userId }).catch(err => console.error(`Erro ao remover notificações para ${userId}:`, err));
        return null;
    });
    if (!member) return;

    const horario = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false }).replace(', ', ' às ');

    // Notificação para 3 dias restantes
    if (daysLeft <= 3 && daysLeft > 2) {
        console.log(`[Debug] Condição de 3 dias atendida para ${userId}, daysLeft: ${daysLeft}`);
        const alreadyNotified = await notificationSent.findOne({ userId, type: '3days' });
        if (!alreadyNotified) {
            const channelName = `expiracao-${member.user.username.toLowerCase()}-3dias`;
            let expirationChannel = guild.channels.cache.find(ch => ch.name === channelName);

            try {
                if (!expirationChannel) {
                    try {
                        expirationChannel = await guild.channels.create({
                            name: channelName,
                            type: ChannelType.GuildText,
                            parent: CATEGORIA_EXPIRATIONS_ID,
                            permissionOverwrites: [
                                { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                                { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
                                { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory] },
                            ],
                        });
                        console.log(`Canal de expiração criado para ${userId}: ${channelName}`);
                    } catch (err) {
                        console.error(`Erro ao criar canal de expiração ${channelName} para ${userId}:`, err);
                        return; // Aborta a execução se o canal não puder ser criado
                    }
                }

                const notifyEmbed = new EmbedBuilder()
                    .setTitle('⚠️ Lembrete: 3 Dias para Expiração')
                    .setDescription(`Sua assinatura VIP está prestes a expirar em ${daysLeft} dias! Renove agora acessando o canal de pagamentos.`)
                    .addFields([
                        { name: '👤 Usuário', value: `${member.user.tag}`, inline: true },
                        { name: '🆔 ID', value: userId, inline: true },
                        { name: '🕒 Horário da Notificação', value: horario, inline: true },
                    ])
                    .setColor('#FFA500')
                    .setTimestamp();

                await expirationChannel.send({
                    content: `<@${userId}>`,
                    embeds: [notifyEmbed],
                });
                await notificationSent.insertOne({ userId, type: '3days', notifiedAt: new Date() });
                console.log(`Notificação de 3 dias enviada para ${userId} no canal privado ${channelName}`);

                setTimeout(async () => {
                    try {
                        if (expirationChannel) {
                            await expirationChannel.delete('Notificação de expiração expirada (12h)');
                            console.log(`Canal de expiração ${channelName} deletado para ${userId}`);
                        }
                    } catch (err) {
                        console.error(`Erro ao deletar canal de expiração ${channelName} para ${userId}:`, err);
                    }
                }, 12 * 60 * 60 * 1000); // 12 horas

                const notificationsChannel = await guild.channels.fetch(NOTIFICACOES_ID).catch(err => {
                    console.error('Erro ao buscar canal de notificações:', err);
                    return null;
                });
                if (notificationsChannel) {
                    const publicNotifyEmbed = new EmbedBuilder()
                        .setTitle('⚠️ Lembrete: 3 Dias para Expiração')
                        .setDescription(`A assinatura de <@${userId}> está prestes a expirar em ${daysLeft} dias!`)
                        .addFields([
                            { name: '👤 Usuário', value: `${member.user.tag}`, inline: true },
                            { name: '🆔 ID', value: userId, inline: true },
                            { name: '🕒 Horário da Notificação', value: horario, inline: true },
                        ])
                        .setColor('#FFA500')
                        .setTimestamp();
                    await notificationsChannel.send({ embeds: [publicNotifyEmbed], content: `<@${userId}>` });
                }
            } catch (err) {
                console.error(`Erro ao processar notificação de 3 dias para ${userId}:`, err);
            }
        }
    }

    // Notificação para 1 dia restante
    if (daysLeft === 1) {
        console.log(`[Debug] Condição de 1 dia atendida para ${userId}, daysLeft: ${daysLeft}`);
        const alreadyNotified = await notificationSent.findOne({ userId, type: '1day' });
        if (!alreadyNotified) {
            const channelName = `expiracao-${member.user.username.toLowerCase()}-1dia`;
            let expirationChannel = guild.channels.cache.find(ch => ch.name === channelName);

            try {
                if (!expirationChannel) {
                    expirationChannel = await guild.channels.create({
                        name: channelName,
                        type: ChannelType.GuildText,
                        parent: CATEGORIA_EXPIRATIONS_ID,
                        permissionOverwrites: [
                            { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                            { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
                            { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory] },
                        ],
                    });
                    console.log(`Canal de expiração criado para ${userId}: ${channelName}`);
                }

                const notifyEmbed = new EmbedBuilder()
                    .setTitle('⏳ Lembrete: 1 Dia para Expiração')
                    .setDescription(`Sua assinatura VIP está prestes a expirar em ${daysLeft} dia! Renove agora acessando o canal de pagamentos.`)
                    .addFields([
                        { name: '👤 Usuário', value: `${member.user.tag}`, inline: true },
                        { name: '🆔 ID', value: userId, inline: true },
                        { name: '🕒 Horário da Notificação', value: horario, inline: true },
                    ])
                    .setColor('#FF4500')
                    .setTimestamp();

                await expirationChannel.send({
                    content: `<@${userId}>`,
                    embeds: [notifyEmbed],
                });
                await notificationSent.insertOne({ userId, type: '1day', notifiedAt: new Date() });
                console.log(`Notificação de 1 dia enviada para ${userId} no canal privado ${channelName}`);

                setTimeout(async () => {
                    try {
                        if (expirationChannel) {
                            await expirationChannel.delete('Notificação de expiração expirada (12h)');
                            console.log(`Canal de expiração ${channelName} deletado para ${userId}`);
                        }
                    } catch (err) {
                        console.error(`Erro ao deletar canal de expiração ${channelName} para ${userId}:`, err);
                    }
                }, 12 * 60 * 60 * 1000); // 12 horas

                const notificationsChannel = await guild.channels.fetch(NOTIFICACOES_ID).catch(err => {
                    console.error('Erro ao buscar canal de notificações:', err);
                    return null;
                });
                if (notificationsChannel) {
                    const publicNotifyEmbed = new EmbedBuilder()
                        .setTitle('⏳ Lembrete: 1 Dia para Expiração')
                        .setDescription(`A assinatura de <@${userId}> está prestes a expirar em ${daysLeft} dia!`)
                        .addFields([
                            { name: '👤 Usuário', value: `${member.user.tag}`, inline: true },
                            { name: '🆔 ID', value: userId, inline: true },
                            { name: '🕒 Horário da Notificação', value: horario, inline: true },
                        ])
                        .setColor('#FF4500')
                        .setTimestamp();
                    await notificationsChannel.send({ embeds: [publicNotifyEmbed], content: `<@${userId}>` });
                }
            } catch (err) {
                console.error(`Erro ao processar notificação de 1 dia para ${userId}:`, err);
            }
        }
    }

    // Notificação de expiração
    if (daysLeft <= 0) {
        console.log(`[Debug] Condição de expiração atendida para ${userId}, daysLeft: ${daysLeft}`);
        try {
            const botMember = await guild.members.fetch(client.user.id);
            const botHighestRole = botMember.roles.highest;
            const vipRole = await guild.roles.fetch(VIP_ROLE_ID);
            const aguardandoRole = await guild.roles.fetch(AGUARDANDO_PAGAMENTO_ROLE_ID);

            if (botHighestRole.position <= vipRole.position) {
                console.error(`Bot não tem permissão para remover VIP (hierarquia insuficiente) para ${userId}`);
            } else {
                await member.roles.remove(VIP_ROLE_ID).catch(err => console.error(`Erro ao remover VIP para ${userId}:`, err));
                console.log(`VIP removido para ${userId}`);
            }

            if (botHighestRole.position <= aguardandoRole.position) {
                console.error(`Bot não tem permissão para adicionar AGUARDANDO_PAGAMENTO (hierarquia insuficiente) para ${userId}`);
            } else {
                await member.roles.add(AGUARDANDO_PAGAMENTO_ROLE_ID).catch(err => console.error(`Erro ao adicionar AGUARDANDO_PAGAMENTO para ${userId}:`, err));
                console.log(`AGUARDANDO_PAGAMENTO adicionado para ${userId}`);
            }
        } catch (roleError) {
            console.error(`Erro ao atualizar papéis após expiração para ${userId}:`, roleError);
        }

        const channelName = `expiracao-${member.user.username.toLowerCase()}-expirada`;
        let expirationChannel = guild.channels.cache.find(ch => ch.name === channelName);

        try {
            if (!expirationChannel) {
                expirationChannel = await guild.channels.create({
                    name: channelName,
                    type: ChannelType.GuildText,
                    parent: CATEGORIA_EXPIRATIONS_ID,
                    permissionOverwrites: [
                        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
                        { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory] },
                    ],
                });
                console.log(`Canal de expiração criado para ${userId}: ${channelName}`);
            }

            const expireEmbed = new EmbedBuilder()
                .setTitle('⏳ Assinatura Vencida')
                .setDescription(`Sua assinatura VIP expirou. Renove agora acessando o canal de pagamentos.`)
                .addFields([
                    { name: '👤 Usuário', value: `${member.user.tag}`, inline: true },
                    { name: '🆔 ID', value: userId, inline: true },
                    { name: '🕒 Horário', value: horario, inline: true },
                ])
                .setColor('#FF0000')
                .setTimestamp();

            await expirationChannel.send({
                content: `<@${userId}>`,
                embeds: [expireEmbed],
            });
            console.log(`Notificação de expiração enviada para ${userId} no canal privado ${channelName}`);

            setTimeout(async () => {
                try {
                    if (expirationChannel) {
                        await expirationChannel.delete('Notificação de expiração expirada (12h)');
                        console.log(`Canal de expiração ${channelName} deletado para ${userId}`);
                    }
                } catch (err) {
                    console.error(`Erro ao deletar canal de expiração ${channelName} para ${userId}:`, err);
                }
            }, 12 * 60 * 60 * 1000); // 12 horas

            const notificationsChannel = await guild.channels.fetch(NOTIFICACOES_ID).catch(err => {
                console.error('Erro ao buscar canal de notificações:', err);
                return null;
            });
            if (notificationsChannel) {
                console.log(`Tentando enviar notificação de vencimento para ${userId} no canal ${NOTIFICACOES_ID}`);
                const publicExpireEmbed = new EmbedBuilder()
                    .setTitle('⏳ Assinatura Vencida')
                    .setDescription(`A assinatura de <@${userId}> expirou.`)
                    .addFields([
                        { name: '👤 Usuário', value: `${member.user.tag}`, inline: false },
                        { name: '🆔 ID', value: userId, inline: true },
                        { name: '🕒 Horário', value: horario, inline: true },
                    ])
                    .setColor('#FF0000')
                    .setTimestamp();
                await notificationsChannel.send({ embeds: [publicExpireEmbed], content: `<@${userId}>` }).catch(err => {
                    console.error(`Falha ao enviar notificação de vencimento para ${userId} no canal ${NOTIFICACOES_ID}:`, err);
                });
            }
        } catch (err) {
            console.error(`Erro ao processar notificação de expiração para ${userId}:`, err);
        }

        await expirationDates.deleteOne({ userId });
        await notificationSent.deleteMany({ userId });
    }
}

// Quando o bot estiver online
client.once('ready', async () => {
    console.log(`✅ Bot online como ${client.user.tag}`);

    const guild = await client.guilds.fetch(GUILD_ID);

    // Painel de Registro
    const canalRegistro = await guild.channels.fetch(CANAL_REGISTRO_ID);

    await canalRegistro.permissionOverwrites.edit(guild.roles.everyone, {
        ViewChannel: true,
        SendMessages: false,
        ReadMessageHistory: true,
    });

    const embedRegistro = new EmbedBuilder()
        .setTitle('📝 Registro de Cliente')
        .setDescription('Clique no botão abaixo para se registrar e acessar o canal 🎰➧painel-clientes para adicionar seu saldo.')
        .setColor('#00BFFF');

    const botaoRegistro = new ButtonBuilder()
        .setCustomId('abrir_formulario')
        .setEmoji('📝')
        .setLabel('Registrar-se')
        .setStyle(ButtonStyle.Success);

    const rowRegistro = new ActionRowBuilder().addComponents(botaoRegistro);

    const mensagensRegistro = await canalRegistro.messages.fetch({ limit: 10 });
    const msgExistente = mensagensRegistro.find(m =>
        m.author.id === client.user.id &&
        m.embeds.length > 0 &&
        m.embeds[0].title === embedRegistro.data.title
    );

    if (!msgExistente) {
        const msg = await canalRegistro.send({ embeds: [embedRegistro], components: [rowRegistro] });
        await msg.pin();
    } else {
        await msgExistente.edit({ embeds: [embedRegistro], components: [rowRegistro] });
    }

    // Painel de Adicionar Saldo
    const canalPainel = await guild.channels.fetch(CANAL_PAINEL_ID);

    const embedPainel = new EmbedBuilder()
        .setTitle('📥 Painel de Cliente - Adição de Saldo')
        .setDescription(
            `Seja bem-vindo ao painel de adição de saldo! Aqui você pode adicionar créditos à sua carteira.\n\n` +
            `Clique nos botões abaixo para gerenciar sua conta:\n\n` +
            `📌 Como funciona?\n\nClique no botão abaixo para adicionar saldo à sua conta.\n\n` +
            `⚠️ Importante!\n\nAntes de fazer qualquer pagamento, lembre-se de que não há reembolsos para adição de créditos. \n\n` +
            `💰 Valores\n\nPara ativar sua assinatura pela primeira vez, você precisa ter pelo menos R$ 299,00 de saldo.\n\n` +
            `💡 *Se você não estiver registrado, clique em **#registrar-se** primeiro.*`
        )
        .setColor('#FFD700');

    const botaoAdicionarSaldo = new ButtonBuilder()
        .setCustomId('adicionar_saldo')
        .setEmoji('💰')
        .setLabel('Adicionar Saldo')
        .setStyle(ButtonStyle.Success);

    const botaoConsultarSaldo = new ButtonBuilder()
        .setCustomId('consultar_saldo')
        .setEmoji('🔍')
        .setLabel('Consultar Saldo')
        .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(botaoAdicionarSaldo, botaoConsultarSaldo);

    const mensagens = await canalPainel.messages.fetch({ limit: 10 });
    const mensagemFixa = mensagens.find(m =>
        m.author.id === client.user.id &&
        m.embeds.length > 0 &&
        m.embeds[0].title === embedPainel.data.title
    );

    if (!mensagemFixa) {
        const msg = await canalPainel.send({ embeds: [embedPainel], components: [row] });
        await msg.pin();
    } else {
        await mensagemFixa.edit({ embeds: [embedPainel], components: [row] });
    }

    // Iniciar verificação global de expirações
    if (expirationDates) {
        await startExpirationCheck();
    }
});

// Interações
client.on('interactionCreate', async (interaction) => {
    if (!registeredUsers || !userBalances || !paymentValues || !activePixChannels || !expirationDates || !notificationSent || !paymentHistory || !couponUsage) {
        console.error('Coleções não inicializadas. Aguardando reinicialização...');
        try {
            await interaction.reply({
                content: '❌ Ocorreu um erro interno. Tente novamente mais tarde.',
                ephemeral: true,
            });
        } catch (err) {
            console.error('Erro ao responder interação de coleções não inicializadas:', err);
        }
        return;
    }

    // Botão de abrir formulário
    if (interaction.isButton() && interaction.customId === 'abrir_formulario') {
        const modal = new ModalBuilder()
            .setCustomId('formulario_registro')
            .setTitle('Registro de Cliente');

        const inputNome = new TextInputBuilder()
            .setCustomId('nome')
            .setLabel('Seu nome completo')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const inputWhatsapp = new TextInputBuilder()
            .setCustomId('whatsapp')
            .setLabel('Seu número')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('DDD900000000 (ex: 11912345678)')
            .setRequired(true);

        const row1 = new ActionRowBuilder().addComponents(inputNome);
        const row2 = new ActionRowBuilder().addComponents(inputWhatsapp);

        modal.addComponents(row1, row2);

        await interaction.showModal(modal);
    }

    // Formulário de registro enviado
    if (interaction.isModalSubmit() && interaction.customId === 'formulario_registro') {
        try {
            const nome = interaction.fields.getTextInputValue('nome');
            const whatsapp = interaction.fields.getTextInputValue('whatsapp');

            const phoneRegex = /^\d{2}9\d{8}$/;
            if (!phoneRegex.test(whatsapp)) {
                await interaction.reply({
                    content: '❌ Número inválido! Use o formato brasileiro: DDD900000000 (ex: 11912345678).',
                    ephemeral: true,
                });
                return;
            }

            const existingUser = await registeredUsers.findOne({ userId: interaction.user.id });
            if (existingUser) {
                await interaction.reply({
                    content: '❌ Você já está registrado!',
                    ephemeral: true,
                });
                return;
            }

            const result = await registeredUsers.insertOne({
                userId: interaction.user.id,
                name: nome,
                whatsapp: whatsapp,
                registeredAt: new Date(),
                paymentHistory: []
            });
            const docId = result.insertedId.toString();
            userIdCache.set(docId, interaction.user.id);

            await userBalances.updateOne(
                { userId: interaction.user.id },
                { $set: { balance: 0 } },
                { upsert: true }
            );
            console.log(`Novo usuário registrado: ${nome}, para o ID ${interaction.user.id}`);

            let roleUpdateSuccess = false;
            try {
                const member = await interaction.guild.members.fetch(interaction.user.id);
                const botMember = await interaction.guild.members.fetch(client.user.id);
                const botRoles = botMember.roles.cache.map(r => ({ id: r.id, name: r.name, position: r.position }));
                const highestBotRole = botRoles.reduce((max, role) => role.position > max.position ? role : max, { position: -1 });
                const registeredRole = await interaction.guild.roles.fetch(REGISTRADO_ROLE_ID);
                const userRoles = member.roles.cache.map(r => ({ id: r.id, name: r.name, position: r.position }));

                if (highestBotRole.position <= (registeredRole?.position || 0)) {
                    throw new Error('Bot não tem permissão suficiente para atribuir o cargo de registrado devido à hierarquia de papéis.');
                }

                const highestUserRole = userRoles.reduce((max, role) => role.position > max.position ? role : max, { position: -1 });
                if (highestUserRole.position >= highestBotRole.position) {
                    throw new Error('Bot não pode gerenciar os papéis deste usuário devido a um cargo superior.');
                }

                await member.roles.add(REGISTRADO_ROLE_ID);
                console.log(`Papel ${REGISTRADO_ROLE_ID} adicionado ao usuário ${interaction.user.id}`);
                roleUpdateSuccess = true;
            } catch (roleError) {
                console.error(`Erro ao adicionar o cargo ${REGISTRADO_ROLE_ID} ao usuário ${interaction.user.id}:`, roleError);
                const logChannel = await interaction.guild.channels.fetch(LOGS_BOTS_ID);
                if (logChannel) {
                    const errorEmbed = new EmbedBuilder()
                        .setTitle('⚠️ Erro ao Atribuir Cargo de Registro')
                        .setDescription(`Falha ao adicionar o cargo de registrado para <@${interaction.user.id}> durante o registro.`)
                        .addFields([
                            { name: 'Usuário', value: `${interaction.user.tag} (ID: ${interaction.user.id})`, inline: false },
                            { name: 'Erro', value: roleError.message, inline: false },
                        ])
                        .setColor('#FF0000')
                        .setTimestamp();
                    await logChannel.send({ embeds: [errorEmbed], content: `<@${ADMIN_USER_ID}>` });
                }
                throw new Error('Falha ao adicionar o cargo de registrado. Um administrador foi notificado.');
            }

            const whatsappChannel = await interaction.guild.channels.fetch(CANAL_WHATSAPP_ID);
            if (whatsappChannel) {
                const currentTime = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false }).replace(', ', ' às ');
                const registrationEmbed = new EmbedBuilder()
                    .setTitle('📝 Novo Registro')
                    .addFields([
                        { name: 'Nome', value: nome, inline: true },
                        { name: 'Número', value: whatsapp, inline: true },
                    ])
                    .setFooter({ text: `Hoje às ${currentTime}` })
                    .setColor('#00BFFF')
                    .setTimestamp();
                await whatsappChannel.send({ embeds: [registrationEmbed] });
            }

            await interaction.reply({
                content: `✅ Obrigado, ${nome}! Você foi registrado com sucesso. Seu saldo inicial é R$0.00.${roleUpdateSuccess ? '' : ' ⚠️ Porém, houve um erro ao atribuir seu cargo. Um administrador foi notificado.'}`,
                ephemeral: true,
            });
        } catch (err) {
            console.error('Erro ao processar o formulário:', err);
            try {
                await interaction.reply({
                    content: `❌ Ocorreu um erro ao processar seu registro: ${err.message}`,
                    ephemeral: true,
                });
            } catch (replyErr) {
                console.error('Erro ao responder interação de formulário:', replyErr);
            }
        }
    }

    // Botão de adicionar saldo
    if (interaction.isButton() && interaction.customId === 'adicionar_saldo') {
        try {
            const userExists = await registeredUsers.findOne({ userId: interaction.user.id });
            if (!userExists) {
                await interaction.reply({
                    content: '❌ Você precisa se registrar antes de adicionar saldo. Vá até **#registrar-se**.',
                    ephemeral: true,
                });
                return;
            }

            const activeChannel = await activePixChannels.findOne({ userId: interaction.user.id });
            if (activeChannel) {
                const channelExists = await interaction.guild.channels.fetch(activeChannel.channelId).catch(() => null);
                if (!channelExists) {
                    await activePixChannels.deleteOne({ userId: interaction.user.id });
                    await paymentValues.deleteOne({ channelId: activeChannel.channelId });
                } else {
                    await interaction.reply({
                        content: `❌ Você já possui um canal de pagamento ativo: <#${activeChannel.channelId}>.`,
                        ephemeral: true,
                    });
                    return;
                }
            }

            const modal = new ModalBuilder()
                .setCustomId('formulario_saldo')
                .setTitle('Adicionar Saldo');

            const inputValor = new TextInputBuilder()
                .setCustomId('valor')
                .setLabel('Valor desejado (ex: 299)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Digite o valor em reais')
                .setRequired(false);

            const inputCupom = new TextInputBuilder()
                .setCustomId('cupom')
                .setLabel('Cupom (opcional)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Digite o código do cupom ou deixe em branco')
                .setRequired(false);

            const row1 = new ActionRowBuilder().addComponents(inputValor);
            const row2 = new ActionRowBuilder().addComponents(inputCupom);
            modal.addComponents(row1, row2);

            await interaction.showModal(modal);
        } catch (err) {
            console.error('Erro ao abrir formulário de saldo:', err);
            try {
                await interaction.reply({
                    content: '❌ Ocorreu um erro ao abrir o formulário de saldo.',
                    ephemeral: true,
                });
            } catch (replyErr) {
                console.error('Erro ao responder interação de adicionar saldo:', replyErr);
            }
        }
    }

    const newIndicationCoupons = ['SOUZASETE', 'MT', 'RNUNES', 'DG', 'GREENZADA', 'BLACKGG', 'COQUIN7', 'NIKEGREEN', 'THCARRILLO', 'GOMESCITY', 'ITZGOD'];

    // Formulário de saldo enviado
    if (interaction.isModalSubmit() && interaction.customId === 'formulario_saldo') {
        await interaction.deferReply({ ephemeral: true }).catch(err => console.error('Erro ao deferir resposta:', err));

        try {
            const valor = interaction.fields.getTextInputValue('valor');
            const cupom = interaction.fields.getTextInputValue('cupom')?.trim().toUpperCase();

            if (!valor && !cupom) {
                await interaction.editReply({
                    content: '❌ Você deve fornecer um valor ou um cupom válido.',
                    ephemeral: true,
                });
                return;
            }

            const guild = interaction.guild;
            const userId = interaction.user.id;
            const member = await guild.members.fetch(userId).catch(err => {
                console.error(`Erro ao buscar membro ${userId}:`, err);
                return null;
            });
            if (!member) {
                await interaction.editReply({
                    content: '❌ Usuário não encontrado no servidor. Contate o suporte.',
                    ephemeral: true,
                });
                return;
            }

            let parsedValor = 0;
            let isDiscountApplied = false;

            // Verificar se um cupom foi fornecido
            if (cupom) {
                if (cupom === 'GHOST2DAYS') {
                    const couponUsed = await couponUsage.findOne({ userId, coupon: 'GHOST2DAYS' });
                    if (couponUsed) {
                        await interaction.editReply({
                            content: '❌ Você já utilizou o cupom GHOST2DAYS anteriormente.',
                            ephemeral: true,
                        });
                        return;
                    }

                    const now = Date.now();
                    let expirationDate;
                    const existingExpiration = await expirationDates.findOne({ userId });
                    if (existingExpiration && new Date(existingExpiration.expirationDate) > new Date(now)) {
                        const daysLeft = calculateDaysLeft(existingExpiration.expirationDate, now);
                        console.log(`Usuário ${userId} tem ${daysLeft} dias restantes na assinatura atual. Adicionando 2 dias via cupom.`);
                        const additionalDaysInMs = daysLeft * 24 * 60 * 60 * 1000;
                        expirationDate = now + additionalDaysInMs + (2 * 24 * 60 * 60 * 1000);
                    } else {
                        expirationDate = now + (2 * 24 * 60 * 60 * 1000);
                    }
                    console.log(`[${new Date(now).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}] Data de expiração definida para ${userId} via cupom: ${new Date(expirationDate).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);

                    await expirationDates.updateOne(
                        { userId },
                        { $set: { expirationDate: expirationDate, createdAt: new Date(now) } },
                        { upsert: true }
                    );

                    await couponUsage.insertOne({
                        userId,
                        coupon: 'GHOST2DAYS',
                        usedAt: new Date(now),
                    });

                    const botMember = await guild.members.fetch(client.user.id);
                    const botHighestRole = botMember.roles.highest;
                    const vipRole = await guild.roles.fetch(VIP_ROLE_ID);
                    const aguardandoRole = await guild.roles.fetch(AGUARDANDO_PAGAMENTO_ROLE_ID);

                    let roleUpdateSuccess = false;
                    if (botHighestRole.position > vipRole.position) {
                        await member.roles.add(VIP_ROLE_ID).catch(err => console.error(`Erro ao adicionar VIP para ${userId}:`, err));
                        await member.roles.remove(AGUARDANDO_PAGAMENTO_ROLE_ID).catch(err => console.error(`Erro ao remover AGUARDANDO_PAGAMENTO para ${userId}:`, err));
                        roleUpdateSuccess = true;
                    } else {
                        console.error(`Bot não tem permissão para gerenciar VIP para ${userId} devido à hierarquia.`);
                    }

                    const logsCouponsChannel = await guild.channels.fetch(LOG_COUPONS_ID).catch(err => {
                        console.error(`Erro ao buscar canal de cupons ${LOG_COUPONS_ID}:`, err);
                        return null;
                    });
                    if (logsCouponsChannel) {
                        const horario = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false }).replace(', ', ' às ');
                        const couponEmbed = new EmbedBuilder()
                            .setTitle('🎟️ Cupom Utilizado')
                            .setDescription(`O usuário <@${userId}> utilizou o cupom GHOST2DAYS.`)
                            .addFields([
                                { name: '👤 Usuário', value: `${member.user.tag}`, inline: false },
                                { name: '🆔 ID', value: userId, inline: true },
                                { name: '🕒 Horário', value: horario, inline: true },
                                { name: '✅ Papéis Atualizados', value: roleUpdateSuccess ? 'Sim' : 'Não', inline: true },
                            ])
                            .setColor('#00FF00')
                            .setTimestamp();
                        await logsCouponsChannel.send({ embeds: [couponEmbed] });
                    }

                    await interaction.editReply({
                        content: `✅ Cupom GHOST2DAYS aplicado com sucesso! Sua assinatura foi estendida por 2 dias.${roleUpdateSuccess ? '' : ' ⚠️ Porém, houve um erro ao atualizar seus papéis. Um administrador foi notificado.'}`,
                        ephemeral: true,
                    });
                    return;
                } else if (newIndicationCoupons.includes(cupom) || cupom === 'SONECA') {
                    const couponUsed = await couponUsage.findOne({ userId, coupon: cupom });
                    if (couponUsed) {
                        await interaction.editReply({
                            content: `❌ Você já utilizou o cupom ${cupom} anteriormente.`,
                            ephemeral: true,
                        });
                        return;
                    }

                    if (valor) {
                        // Verificar o valor fornecido com o cupom
                        if (!/^\d+(\.\d{2})?$/.test(valor)) {
                            await interaction.editReply({
                                content: '❌ Por favor, insira um valor válido (ex: 299).',
                                ephemeral: true,
                            });
                            return;
                        }

                        parsedValor = parseFloat(valor);
                        if (parsedValor !== 99 && parsedValor < 299) {
                            await interaction.editReply({
                                content: '❌ Esse valor não é suficiente. R$99 para semanal (7 dias) ou R$299 para mensal (30 dias).',
                                ephemeral: true,
                            });
                            return;
                        }
                        isDiscountApplied = true;
                    } else {
                        // Caso apenas o cupom seja fornecido, definir indicação sem criar canal PIX
                        await registeredUsers.updateOne(
                            { userId },
                            { $set: { indication: cupom } },
                            { upsert: true }
                        );

                        await couponUsage.insertOne({
                            userId,
                            coupon: cupom,
                            usedAt: new Date(),
                        });

                        const logsCouponsChannel = await guild.channels.fetch(LOG_COUPONS_ID).catch(err => {
                            console.error(`Erro ao buscar canal de cupons ${LOG_COUPONS_ID}:`, err);
                            return null;
                        });
                        if (logsCouponsChannel) {
                            const horario = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false }).replace(', ', ' às ');
                            const couponEmbed = new EmbedBuilder()
                                .setTitle('🎟️ Cupom Utilizado')
                                .setDescription(`O usuário <@${userId}> utilizou o cupom ${cupom} para definir indicação.`)
                                .addFields([
                                    { name: '👤 Usuário', value: `${member.user.tag}`, inline: false },
                                    { name: '🆔 ID', value: userId, inline: true },
                                    { name: '🕒 Horário', value: horario, inline: true },
                                    { name: '📋 Indicação', value: cupom, inline: true },
                                ])
                                .setColor('#00FF00')
                                .setTimestamp();
                            await logsCouponsChannel.send({ embeds: [couponEmbed] });
                        }

                        await interaction.editReply({
                            content: `✅ Cupom ${cupom} aplicado com sucesso! Sua indicação foi definida como "${cupom}".`,
                            ephemeral: true,
                        });
                        return;
                    }
                } else {
                    await interaction.editReply({
                        content: '❌ Cupom inválido. Use um cupom válido ou deixe em branco para pagamento PIX.',
                        ephemeral: true,
                    });
                    return;
                }
            } else if (valor) {
                // Caso apenas o valor seja fornecido (sem cupom)
                if (!/^\d+(\.\d{2})?$/.test(valor)) {
                    await interaction.editReply({
                        content: '❌ Por favor, insira um valor válido (ex: 299).',
                        ephemeral: true,
                    });
                    return;
                }

                parsedValor = parseFloat(valor);
                if (parsedValor !== 99 && parsedValor < 299) {
                    await interaction.editReply({
                        content: '❌ Esse valor não é suficiente. R$99 para semanal (7 dias) ou R$299 para mensal (30 dias).',
                        ephemeral: true,
                    });
                    return;
                }
            }

            // Criar canal PIX se um valor válido foi fornecido
            const nomeCanal = `pix-${interaction.user.username.toLowerCase()}`;
            const canalExistente = guild.channels.cache.find(ch => ch.name === nomeCanal);

            if (canalExistente) {
                await interaction.editReply({
                    content: `📌 Você já possui um canal de pagamento: ${canalExistente}.`,
                    ephemeral: true,
                });
                return;
            }

            const duration = parsedValor === 99 ? 7 : 30;

            const canalPix = await guild.channels.create({
                name: nomeCanal,
                type: ChannelType.GuildText,
                parent: CATEGORIA_PAGAMENTOS_ID,
                permissionOverwrites: [
                    { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                    { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
                    { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory] },
                ],
            });

            const embedPix = new EmbedBuilder()
                .setTitle('💳 Pagamento via PIX - Adicionar Saldo')
                .setDescription(
                    'Faça o pagamento usando os dados abaixo e envie o comprovante PIX (IMAGEM) neste canal.\n' +
                    '⚠️ **Você tem 24 horas para confirmar o pagamento.**'
                )
                .addFields([
                    { name: '💰 Valor', value: `R$${parsedValor.toFixed(2)}`, inline: true },
                    { name: '🕓 Validade', value: '24h', inline: true },
                    { name: 'Chave PIX', value: PIX_DATA.chave, inline: false },
                    { name: 'Nome', value: PIX_DATA.nome, inline: true },
                    { name: 'Instruções', value: '1. Copie a chave PIX\n2. Abra seu app de banco\n3. Pague com PIX\n4. Envie o comprovante (IMAGEM) aqui', inline: false },
                    ...(isDiscountApplied ? [{ name: '🎟️ Cupom', value: cupom, inline: true }] : []),
                    { name: '📅 Duração', value: `${duration} dias`, inline: true },
                ])
                .setColor('#00FF99');

            const botaoCopiarPix = new ButtonBuilder()
                .setCustomId('copiar_chave_pix')
                .setLabel('Copiar Chave PIX')
                .setEmoji('📋')
                .setStyle(ButtonStyle.Primary);

            const botaoConfirmar = new ButtonBuilder()
                .setCustomId('confirmar_pagamento')
                .setLabel('Confirmar Pagamento')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅');

            const row = new ActionRowBuilder().addComponents(botaoCopiarPix, botaoConfirmar);

            const message = await canalPix.send({
                content: `<@${userId}>`,
                embeds: [embedPix],
                components: [row],
            });

            await paymentValues.insertOne({
                channelId: canalPix.id,
                userId: userId,
                value: parsedValor.toString(),
                createdAt: new Date(),
                ...(isDiscountApplied ? { coupon: cupom } : {}),
            });

            await activePixChannels.insertOne({
                userId: userId,
                channelId: canalPix.id,
                createdAt: new Date(),
            });

            // Registrar o cupom de indicação, se aplicável
            if (isDiscountApplied) {
                await registeredUsers.updateOne(
                    { userId },
                    { $set: { indication: cupom } },
                    { upsert: true }
                );

                await couponUsage.insertOne({
                    userId,
                    coupon: cupom,
                    usedAt: new Date(),
                });

                const logsCouponsChannel = await guild.channels.fetch(LOG_COUPONS_ID).catch(err => {
                    console.error(`Erro ao buscar canal de cupons ${LOG_COUPONS_ID}:`, err);
                    return null;
                });
                if (logsCouponsChannel) {
                    const horario = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false }).replace(', ', ' às ');
                    const couponEmbed = new EmbedBuilder()
                        .setTitle('🎟️ Cupom Utilizado')
                        .setDescription(`O usuário <@${userId}> utilizou o cupom ${cupom} de indicação.`)
                        .addFields([
                            { name: '👤 Usuário', value: `${member.user.tag}`, inline: false },
                            { name: '🆔 ID', value: userId, inline: true },
                            { name: '🕒 Horário', value: horario, inline: true },
                            { name: '📋 Indicação', value: cupom, inline: true },
                            { name: '💰 Valor', value: `R$${parsedValor.toFixed(2)}`, inline: true },
                        ])
                        .setColor('#00FF00')
                        .setTimestamp();
                    await logsCouponsChannel.send({ embeds: [couponEmbed] });
                }
            }

            setTimeout(async () => {
                try {
                    const channel = await guild.channels.fetch(canalPix.id).catch(() => null);
                    if (channel) {
                        await channel.delete('Timeout de 24 horas atingido');
                    }
                    await activePixChannels.deleteOne({ userId: userId });
                    await paymentValues.deleteOne({ channelId: canalPix.id });
                } catch (err) {
                    console.error('Erro ao deletar canal PIX após 24h:', err);
                }
            }, 24 * 60 * 60 * 1000); // 24 horas

            await interaction.editReply({
                content: `✅ Seu canal de pagamento foi criado: ${canalPix}.${isDiscountApplied ? ` Cupom ${cupom} de indicação aplicado: R$${parsedValor.toFixed(2)}.` : ''}`,
                ephemeral: true,
            });
        } catch (err) {
            console.error('Erro na criação do canal de pagamento:', err);
            await interaction.editReply({
                content: '❌ Ocorreu um erro ao criar o canal de pagamento.',
                ephemeral: true,
            }).catch(replyErr => console.error('Erro ao editar resposta:', replyErr));
        }
    }

    // Botão de copiar chave PIX
    if (interaction.isButton() && interaction.customId === 'copiar_chave_pix') {
        try {
            await interaction.reply({
                content: `📋 Chave PIX: **${PIX_DATA.chave}**`,
                ephemeral: true,
            });
        } catch (err) {
            console.error('Erro ao responder interação de copiar chave PIX:', err);
        }
    }

    // Confirmação de pagamento
    if (interaction.isButton() && interaction.customId === 'confirmar_pagamento') {
        await interaction.deferReply({ ephemeral: true }).catch(err => console.error('Erro ao deferir resposta:', err));

        try {
            const userId = interaction.message.content.match(/<@(\d+)>/)[1];
            console.log(`Iniciando confirmação de pagamento para userId: ${userId}`);
            if (interaction.user.id !== userId) {
                await interaction.editReply({
                    content: '❌ Apenas o usuário que criou este canal pode confirmar.',
                    ephemeral: true,
                });
                return;
            }

            const member = await interaction.guild.members.fetch(userId).catch(err => {
                console.error(`Erro ao buscar membro ${userId}:`, err);
                return null;
            });
            if (!member) {
                console.warn(`Usuário ${userId} não encontrado no servidor. Ação abortada.`);
                await interaction.editReply({
                    content: '❌ Usuário não encontrado no servidor. Contate o suporte.',
                    ephemeral: true,
                });
                return;
            }

            const canalPix = interaction.channel;
            const botMember = await interaction.guild.members.fetch(client.user.id);
            const botHighestRole = botMember.roles.highest;
            const vipRole = await interaction.guild.roles.fetch(VIP_ROLE_ID);

            if (botHighestRole.position <= vipRole.position) {
                throw new Error('Bot não tem permissão suficiente para atribuir o cargo VIP devido à hierarquia de papéis.');
            }

            const valorRecord = await paymentValues.findOne({ channelId: canalPix.id });
            if (!valorRecord) {
                await interaction.editReply({
                    content: '❌ Nenhum registro de pagamento encontrado. Contate o suporte.',
                    ephemeral: true,
                });
                return;
            }

            const mensagens = await canalPix.messages.fetch({ limit: 100 });
            const comprovante = mensagens.find(m =>
                m.author.id === userId &&
                m.attachments.size > 0 &&
                m.attachments.first().contentType.startsWith('image/')
            );
            if (!comprovante) {
                await interaction.editReply({
                    content: '❌ Envie o comprovante PIX (imagem) antes de confirmar.',
                    ephemeral: true,
                });
                return;
            }
            console.log(`Comprovante encontrado para userId ${userId}`);

            const valor = parseFloat(valorRecord.value);
            console.log(`Valor do pagamento: R$${valor}`);

            let userBalance = await userBalances.findOne({ userId: userId });
            if (!userBalance) {
                await userBalances.insertOne({ userId: userId, balance: 0 });
                userBalance = { balance: 0 };
            }
            await userBalances.updateOne(
                { userId: userId },
                { $set: { balance: userBalance.balance + valor } },
                { upsert: true }
            );
            console.log(`Saldo atualizado para ${userId}: R$${(userBalance.balance + valor).toFixed(2)}`);

            await registeredUsers.updateOne(
                { userId: userId },
                { $push: { paymentHistory: { amount: valor, timestamp: new Date(), reference: '11309256170' } } },
                { upsert: true }
            );
            console.log(`Histórico de pagamento atualizado para ${userId}`);

            let roleUpdateSuccess = false;
            try {
                await member.roles.add(VIP_ROLE_ID).catch(err => console.error(`Erro ao adicionar VIP para ${userId}:`, err));
                await member.roles.remove(AGUARDANDO_PAGAMENTO_ROLE_ID).catch(err => console.error(`Erro ao remover AGUARDANDO_PAGAMENTO para ${userId}:`, err));
                roleUpdateSuccess = true;
            } catch (roleError) {
                console.error(`Erro ao atualizar papéis para ${userId}:`, roleError);
                const logChannel = await interaction.guild.channels.fetch(LOGS_BOTS_ID);
                if (logChannel) {
                    const errorEmbed = new EmbedBuilder()
                        .setTitle('⚠️ Erro ao Atualizar Papéis')
                        .setDescription(`Falha ao atualizar papéis para <@${userId}> após pagamento.`)
                        .addFields([
                            { name: 'Usuário', value: `${member.user.tag} (ID: ${userId})`, inline: false },
                            { name: 'Erro', value: roleError.message, inline: false },
                        ])
                        .setColor('#FF0000')
                        .setTimestamp();
                    await logChannel.send({ embeds: [errorEmbed], content: `<@${ADMIN_USER_ID}>` });
                }
            }

            const embedConfirmado = new EmbedBuilder()
                .setTitle('✅ Pagamento Confirmado')
                .setDescription(`O pagamento de <@${userId}> foi confirmado com sucesso!\nComprovante: [Ver Imagem](${comprovante.attachments.first().url})`)
                .setColor('#00FF00');

            await interaction.message.edit({
                embeds: [embedConfirmado],
                components: [],
            });
            console.log(`Mensagem de canal atualizada para ${userId}`);

            await interaction.editReply({
                content: `✅ Pagamento confirmado. Novo saldo: R$${(userBalance.balance + valor).toFixed(2)}.${roleUpdateSuccess ? '' : ' ⚠️ Porém, houve um erro ao atualizar seus papéis. Um administrador foi notificado.'}`,
                ephemeral: true,
            });
            console.log(`Resposta enviada ao usuário ${userId}`);

            const logChannel = await interaction.guild.channels.fetch(LOG_PAGAMENTOS_ID);
            if (logChannel) {
                const horario = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false }).replace(', ', ' às ');
                const logEmbed = new EmbedBuilder()
                    .setTitle('💰 Pagamento Aprovado')
                    .setDescription('Um novo pagamento foi aprovado!')
                    .addFields([
                        { name: '👤 Usuário', value: `${member.user.tag} (ID: ${userId})`, inline: false },
                        { name: '💸 Valor', value: `R$${valor}`, inline: true },
                        { name: '📝 Referência', value: '11309256170', inline: true },
                        { name: '🕒 Horário', value: horario, inline: false },
                    ])
                    .setColor('#00FF00')
                    .setTimestamp();
                await logChannel.send({ embeds: [logEmbed] });
                await paymentValues.deleteOne({ channelId: canalPix.id });
                console.log(`Log de pagamento enviado e registro deletado para ${userId}`);
            }

            const logsBotsChannel = await interaction.guild.channels.fetch(LOGS_BOTS_ID);
            if (logsBotsChannel) {
                const horario = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false }).replace(', ', ' às ');
                const renewEmbed = new EmbedBuilder()
                    .setTitle('🔄 Assinatura Renovada')
                    .setDescription('A assinatura de um usuário foi renovada!')
                    .addFields([
                        { name: '👤 Usuário', value: `${member.user.tag}`, inline: false },
                        { name: '🆔 ID', value: userId, inline: true },
                        { name: '🕒 Horário', value: horario, inline: true },
                        { name: '✅ Papéis Atualizados', value: roleUpdateSuccess ? 'Sim' : 'Não', inline: true },
                    ])
                    .setColor(roleUpdateSuccess ? '#00FF00' : '#FFA500')
                    .setTimestamp();
                await logsBotsChannel.send({ embeds: [renewEmbed] });
                console.log(`Log de renovação enviado para ${userId}`);
            }

            await activePixChannels.deleteOne({ userId: userId });
            console.log(`Canal ativo deletado para ${userId}`);

            if (roleUpdateSuccess) {
                const now = Date.now();
                let expirationDate;
                const existingExpiration = await expirationDates.findOne({ userId: userId });
                const duration = valor === 99 ? 7 : 30; // 7 days for R$99, 30 days for R$299 or higher
                if (existingExpiration && new Date(existingExpiration.expirationDate) > new Date(now)) {
                    const daysLeft = calculateDaysLeft(existingExpiration.expirationDate, now);
                    console.log(`Usuário ${userId} tem ${daysLeft} dias restantes na assinatura atual.`);
                    const additionalDaysInMs = daysLeft * 24 * 60 * 60 * 1000;
                    expirationDate = now + additionalDaysInMs + (duration * 24 * 60 * 60 * 1000);
                } else {
                    expirationDate = now + (duration * 24 * 60 * 60 * 1000);
                }
                console.log(`[${new Date(now).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}] Data de expiração definida para ${userId}: ${new Date(expirationDate).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);

                await expirationDates.updateOne(
                    { userId: userId },
                    { $set: { expirationDate: expirationDate, createdAt: new Date(now) } },
                    { upsert: true }
                );
            }
        } catch (err) {
            console.error(`Erro ao confirmar pagamento para ${userId}:`, err);
            await interaction.editReply({
                content: `❌ Ocorreu um erro ao confirmar o pagamento: ${err.message}. Contate o administrador se o problema persistir.`,
                ephemeral: true,
            }).catch(replyErr => console.error('Erro ao editar resposta:', replyErr));
        }
    }

    // Botão consultar saldo
    if (interaction.isButton() && interaction.customId === 'consultar_saldo') {
        try {
            const userExists = await registeredUsers.findOne({ userId: interaction.user.id });
            if (!userExists) {
                await interaction.reply({
                    content: '❌ Você precisa se registrar antes de consultar o saldo.',
                    ephemeral: true,
                });
                return;
            }

            const userBalance = await userBalances.findOne({ userId: interaction.user.id }) || { balance: 0 };
            console.log(`Consulta de saldo para ${interaction.user.id}: ${userBalance.balance}`);

            const expirationRecord = await expirationDates.findOne({ userId: interaction.user.id });
            let expirationMessage = '';
            if (expirationRecord) {
                const now = Date.now();
                const daysLeft = calculateDaysLeft(expirationRecord.expirationDate, now);
                console.log(`[${new Date(now).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}] Consultar Saldo - Usuário ${interaction.user.id}: Expiração em ${new Date(expirationRecord.expirationDate).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}, ${daysLeft} dias restantes`);
                expirationMessage = `\nSua assinatura VIP expira em ${daysLeft} dias.`;
            }

            await interaction.reply({
                content: `✅ Seu saldo atual é: R$${userBalance.balance.toFixed(2)}.${expirationMessage}`,
                ephemeral: true,
            });
        } catch (err) {
            console.error('Erro ao consultar saldo:', err);
            try {
                await interaction.reply({
                    content: '❌ Ocorreu um erro ao consultar o saldo.',
                    ephemeral: true,
                });
            } catch (replyErr) {
                console.error('Erro ao responder interação de consultar saldo:', replyErr);
            }
        }
    }
});

initializeCollections().catch(console.error);

client.login(process.env.DISCORD_TOKEN);