import { Server as SocketIOServer } from "socket.io";
import { hashApiKey } from "../utils/crypto";
import { getSupabase } from "../db/supabase";
import { addToQueue, removeFromQueue, tryMatch } from "../game/matchmaking";
import {
  ROUND_TIMEOUT_SECONDS,
  WINS_TO_WIN_MATCH,
  getWagerAmount,
  type WagerTier,
  type RpsChoice,
} from "../game/constants";
import { resolveRound } from "../game/rps";
import {
  isEscrowConfigured,
  getMatchDeposits,
  resolveMatch,
  cancelAndRefundMatch,
} from "../chain/escrow";
import { config } from "../config";

type SocketData = {
  agentId?: string;
  agentName?: string;
  currentMatchId?: string;
};

/** In-memory state for matches in "playing" phase: current round choices and endsAt. */
const matchState = new Map<
  string,
  {
    agent1Id: string;
    agent2Id: string;
    agent1Wins: number;
    agent2Wins: number;
    currentRound: number;
    roundEndsAt: Date;
    choice1: RpsChoice | null;
    choice2: RpsChoice | null;
  }
>();

/** Socket id -> agent id (for disconnect / forfeit). */
const socketToAgent = new Map<string, string>();

const DEPOSIT_TIMEOUT_JOB_MS = 60_000;

/** Run periodically: cancel matches past deposit_timeout_at and emit match_cancelled. */
export function startDepositTimeoutJob(io: SocketIOServer): void {
  if (!isEscrowConfigured()) return;
  setInterval(async () => {
    const supabase = getSupabase();
    const now = new Date().toISOString();
    const { data: rows } = await supabase
      .from("matches")
      .select("id")
      .eq("status", "waiting_deposits")
      .lt("deposit_timeout_at", now);
    if (!rows?.length) return;
    for (const row of rows) {
      const txHash = await cancelAndRefundMatch(row.id);
      if (txHash) {
        await supabase.from("matches").update({ status: "cancelled" }).eq("id", row.id);
        io.to(`match:${row.id}`).emit("match_cancelled", { matchId: row.id, reason: "deposit_timeout", txHash });
      }
    }
  }, DEPOSIT_TIMEOUT_JOB_MS);
}

export function setupSocket(io: SocketIOServer): void {
  io.on("connection", (socket) => {
    socket.on("authenticate", async (payload: { apiKey?: string }) => {
      const apiKey = payload?.apiKey?.trim();
      if (!apiKey) {
        socket.emit("auth_error", { error: "API key required" });
        return;
      }

      const hash = hashApiKey(apiKey);
      const supabase = getSupabase();
      const { data: agent, error } = await supabase
        .from("agents")
        .select("id, name")
        .eq("api_key_hash", hash)
        .single();

      if (error || !agent) {
        socket.emit("auth_error", { error: "Invalid API key" });
        return;
      }

      (socket.data as SocketData).agentId = agent.id;
      (socket.data as SocketData).agentName = agent.name;
      socketToAgent.set(socket.id, agent.id);
      socket.emit("authenticated", { agentId: agent.id, name: agent.name });
    });

    socket.on("join_queue", async (payload: { wager_tier?: number }) => {
      const data = socket.data as SocketData;
      if (!data.agentId || !data.agentName) {
        socket.emit("auth_error", { error: "Authenticate first" });
        return;
      }

      const tier = payload?.wager_tier;
      if (tier === undefined || tier === null || ![1, 2, 3, 4].includes(tier)) {
        socket.emit("error", { error: "wager_tier must be 1, 2, 3, or 4" });
        return;
      }

      const wagerTier = tier as WagerTier;
      addToQueue({
        agentId: data.agentId,
        agentName: data.agentName,
        socketId: socket.id,
        wagerTier,
        joinedAt: new Date(),
      });

      const result = await tryMatch(wagerTier);
      if (!result) return;

      const { matchId, agent1, agent2 } = result;
      const wagerAmount = getWagerAmount(wagerTier);

      const agent1Socket = io.sockets.sockets.get(agent1.socketId);
      const agent2Socket = io.sockets.sockets.get(agent2.socketId);

      const payload1: Record<string, unknown> = {
        gameId: matchId,
        opponent: { id: agent2.agentId, name: agent2.agentName },
        wager_tier: wagerTier,
        wager_amount_MON: wagerAmount,
        best_of: 5,
      };
      const payload2: Record<string, unknown> = {
        gameId: matchId,
        opponent: { id: agent1.agentId, name: agent1.agentName },
        wager_tier: wagerTier,
        wager_amount_MON: wagerAmount,
        best_of: 5,
      };
      if (result.escrow && config.escrow.address) {
        payload1.escrow_address = config.escrow.address;
        payload1.deposit_match_id_hex = result.escrow.matchIdHex;
        payload1.wager_wei = result.escrow.wagerWei;
        payload2.escrow_address = config.escrow.address;
        payload2.deposit_match_id_hex = result.escrow.matchIdHex;
        payload2.wager_wei = result.escrow.wagerWei;
      }

      agent1Socket?.emit("game_matched", payload1);
      agent2Socket?.emit("game_matched", payload2);

      if (agent1Socket?.data !== undefined) (agent1Socket.data as SocketData).currentMatchId = matchId;
      if (agent2Socket?.data !== undefined) (agent2Socket.data as SocketData).currentMatchId = matchId;
    });

    socket.on("deposit_tx", async (payload: { gameId?: string; txHash?: string }) => {
      const data = socket.data as SocketData;
      if (!data.agentId) {
        socket.emit("error", { error: "Authenticate first" });
        return;
      }
      const gameId = payload?.gameId?.trim();
      const txHash = payload?.txHash?.trim();
      if (!gameId || !txHash) {
        socket.emit("error", { error: "gameId and txHash required" });
        return;
      }
      const supabase = getSupabase();
      const { data: match, error } = await supabase
        .from("matches")
        .select("id, agent1_id, agent2_id, status, agent1_deposit_tx_hash, agent2_deposit_tx_hash")
        .eq("id", gameId)
        .eq("status", "waiting_deposits")
        .single();
      if (error || !match) {
        socket.emit("error", { error: "Match not found or not waiting for deposits" });
        return;
      }
      const isAgent1 = match.agent1_id === data.agentId;
      const isAgent2 = match.agent2_id === data.agentId;
      if (!isAgent1 && !isAgent2) {
        socket.emit("error", { error: "You are not a player in this match" });
        return;
      }
      if (isAgent1 && match.agent1_deposit_tx_hash) {
        socket.emit("error", { error: "Agent 1 deposit already recorded" });
        return;
      }
      if (isAgent2 && match.agent2_deposit_tx_hash) {
        socket.emit("error", { error: "Agent 2 deposit already recorded" });
        return;
      }
      const update =
        isAgent1
          ? { agent1_deposit_tx_hash: txHash }
          : { agent2_deposit_tx_hash: txHash };
      const { error: updateError } = await supabase.from("matches").update(update).eq("id", gameId);
      if (updateError) {
        socket.emit("error", { error: "Failed to save deposit tx" });
        return;
      }
      socket.emit("deposit_tx_saved", { gameId, txHash });
    });

    socket.on("join_game", async (payload: { gameId?: string }) => {
      const data = socket.data as SocketData;
      const gameId = payload?.gameId?.trim();
      if (!gameId) {
        socket.emit("error", { error: "gameId required" });
        return;
      }
      socket.join(`match:${gameId}`);
      data.currentMatchId = gameId;

      let state = matchState.get(gameId);
      if (state) {
        socket.emit("game_state", {
          matchId: gameId,
          currentRound: state.currentRound,
          agent1Wins: state.agent1Wins,
          agent2Wins: state.agent2Wins,
          phase: "playing",
          endsAt: state.roundEndsAt.toISOString(),
        });
        return;
      }

      setImmediate(async () => {
        const room = io.sockets.adapter.rooms.get(`match:${gameId}`);
        if (room?.size !== 2) return;
        if (matchState.has(gameId)) return;

        const supabase = getSupabase();
        const { data: match, error } = await supabase
          .from("matches")
          .select("id, agent1_id, agent2_id, deposit_timeout_at")
          .eq("id", gameId)
          .eq("status", "waiting_deposits")
          .single();

        if (error || !match) return;

        const matchId = match.id as string;
        const matchData = match;

        const tryStart = async (): Promise<boolean> => {
          if (!isEscrowConfigured()) return true;
          const deposits = await getMatchDeposits(matchId);
          if (!deposits) {
            console.warn("[escrow] getMatchDeposits null for match", matchId);
            return false;
          }
          if (deposits.cancelled) return false;
          if (!deposits.deposit1 || !deposits.deposit2) {
            console.warn("[escrow] deposits not ready:", { deposit1: deposits.deposit1, deposit2: deposits.deposit2 });
            return false;
          }
          return true;
        };

        let started = await tryStart();
        if (!started) {
          for (let i = 0; i < 5; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            started = await tryStart();
            if (started) break;
          }
        }

        if (!started) {
          io.to(`match:${matchId}`).emit("waiting_deposits", {
            matchId: gameId,
            message: "Deposit MON to escrow to start. Re-send join_game when both have deposited.",
          });
          const deadline = new Date(matchData.deposit_timeout_at).getTime();
          const poll = setInterval(async () => {
            if (matchState.has(matchId)) {
              clearInterval(poll);
              return;
            }
            const { data: m } = await supabase.from("matches").select("status").eq("id", matchId).single();
            if (m?.status !== "waiting_deposits") {
              clearInterval(poll);
              return;
            }
            if (Date.now() > deadline) {
              clearInterval(poll);
              return;
            }
            if (await tryStart()) {
              clearInterval(poll);
              void startRounds();
            }
          }, 3000);
          return;
        }

        void startRounds();

        async function startRounds() {
          if (matchState.has(matchId)) return;
          const roundEndsAt = new Date(Date.now() + ROUND_TIMEOUT_SECONDS * 1000);
          state = {
            agent1Id: matchData.agent1_id,
            agent2Id: matchData.agent2_id,
            agent1Wins: 0,
            agent2Wins: 0,
            currentRound: 1,
            roundEndsAt,
            choice1: null,
            choice2: null,
          };
          matchState.set(matchId, state);

          const { error: statusErr } = await supabase
            .from("matches")
            .update({ status: "playing", current_round: 1, round_ends_at: roundEndsAt.toISOString() })
            .eq("id", matchId);
          if (statusErr) {
            console.error("[socket] Failed to set match status to playing:", matchId, statusErr);
            matchState.delete(matchId);
            io.to(`match:${matchId}`).emit("error", { error: "Failed to start match" });
            return;
          }

          io.to(`match:${matchId}`).emit("game_state", {
            matchId,
            currentRound: 1,
            agent1Wins: 0,
            agent2Wins: 0,
            phase: "playing",
            endsAt: roundEndsAt.toISOString(),
          });
          io.to(`match:${matchId}`).emit("round_start", {
            round: 1,
            endsAt: roundEndsAt.toISOString(),
          });
        }
      });
    });

    socket.on("throw", (payload: { choice?: string }) => {
      const data = socket.data as SocketData;
      const matchId = data.currentMatchId;
      if (!matchId || !data.agentId) {
        socket.emit("error", { error: "Join a game first" });
        return;
      }

      const choice = payload?.choice?.toLowerCase();
      if (!choice || !["rock", "paper", "scissors"].includes(choice)) {
        socket.emit("error", { error: "choice must be rock, paper, or scissors" });
        return;
      }

      const state = matchState.get(matchId);
      if (!state) {
        socket.emit("error", { error: "Match not in playing state" });
        return;
      }

      const isAgent1 = state.agent1Id === data.agentId;
      if (isAgent1 && state.choice1 === null) state.choice1 = choice as RpsChoice;
      else if (!isAgent1 && state.choice2 === null) state.choice2 = choice as RpsChoice;
      else {
        socket.emit("error", { error: "Already submitted for this round" });
        return;
      }

      if (state.choice1 !== null && state.choice2 !== null) {
        void finishRound(io, matchId, state);
      }
    });

    socket.on("disconnect", () => {
      const agentId = (socket.data as SocketData).agentId;
      if (agentId) {
        removeFromQueue(agentId);
        socketToAgent.delete(socket.id);
      }
    });
  });
}

type MatchState = {
  agent1Id: string;
  agent2Id: string;
  agent1Wins: number;
  agent2Wins: number;
  currentRound: number;
  roundEndsAt: Date;
  choice1: RpsChoice | null;
  choice2: RpsChoice | null;
};

async function finishRound(io: SocketIOServer, matchId: string, state: MatchState): Promise<void> {
  const winnerId = resolveRound(
    state.choice1,
    state.choice2,
    state.agent1Id,
    state.agent2Id
  );

  if (winnerId === state.agent1Id) state.agent1Wins++;
  else if (winnerId === state.agent2Id) state.agent2Wins++;

  const supabase = getSupabase();
  await supabase.from("rounds").insert({
    match_id: matchId,
    round_index: state.currentRound,
    choice_agent1: state.choice1,
    choice_agent2: state.choice2,
    winner_agent_id: winnerId,
  });

  await supabase
    .from("matches")
    .update({
      agent1_wins: state.agent1Wins,
      agent2_wins: state.agent2Wins,
      current_round: state.currentRound,
      round_ends_at: null,
    })
    .eq("id", matchId);

  io.to(`match:${matchId}`).emit("round_result", {
    round: state.currentRound,
    choice1: state.choice1,
    choice2: state.choice2,
    winnerAgentId: winnerId,
    agent1Wins: state.agent1Wins,
    agent2Wins: state.agent2Wins,
  });

  if (state.agent1Wins >= WINS_TO_WIN_MATCH || state.agent2Wins >= WINS_TO_WIN_MATCH) {
    const winner = state.agent1Wins >= WINS_TO_WIN_MATCH ? state.agent1Id : state.agent2Id;
    const loser = winner === state.agent1Id ? state.agent2Id : state.agent1Id;

    await supabase
      .from("matches")
      .update({ status: "settled", winner_agent_id: winner })
      .eq("id", matchId);

    let payoutTxHash: string | null = null;
    if (isEscrowConfigured()) {
      const { data: winnerAgent } = await supabase.from("agents").select("wallet_address").eq("id", winner).single();
      const winnerAddr = winnerAgent?.wallet_address?.trim();
      if (winnerAddr) {
        const hash = await resolveMatch(matchId, winnerAddr as `0x${string}`);
        if (hash) {
          payoutTxHash = hash;
          await supabase.from("matches").update({ payout_tx_hash: hash }).eq("id", matchId);
        }
      }
    }

    const { data: winnerRow } = await supabase.from("agents").select("wins").eq("id", winner).single();
    const { data: loserRow } = await supabase.from("agents").select("losses").eq("id", loser).single();
    if (winnerRow) await supabase.from("agents").update({ wins: winnerRow.wins + 1 }).eq("id", winner);
    if (loserRow) await supabase.from("agents").update({ losses: loserRow.losses + 1 }).eq("id", loser);

    io.to(`match:${matchId}`).emit("game_ended", {
      winner,
      score: { agent1: state.agent1Wins, agent2: state.agent2Wins },
      payout: null,
      txHashPayout: payoutTxHash,
    });
    matchState.delete(matchId);
    return;
  }

  state.currentRound++;
  state.roundEndsAt = new Date(Date.now() + ROUND_TIMEOUT_SECONDS * 1000);
  state.choice1 = null;
  state.choice2 = null;

  await supabase
    .from("matches")
    .update({
      current_round: state.currentRound,
      round_ends_at: state.roundEndsAt.toISOString(),
    })
    .eq("id", matchId);

  matchState.set(matchId, state);

  io.to(`match:${matchId}`).emit("round_start", {
    round: state.currentRound,
    endsAt: state.roundEndsAt.toISOString(),
  });
}
