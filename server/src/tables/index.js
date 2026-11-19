/* Table games: games the SERVER plays out move by move (chess, poker), unlike race games where every player plays the same
   seeded challenge on their own device and reports a score. Hidden information (cards) and every rule live here, so a
   modified client can neither see what it should not nor make a move the rules forbid.

   Every engine module exports the same functions, all working on a plain-JSON state:
     create({ n, now, randInt, opts })  → state          view(state, seat, now) → what that seat may see
     act(state, seat, action, now)        (throws AppError on an illegal action)
     deadline(state) → ms | null          onTimer(state, now)     (the clock: timeouts, the next hand)
     forfeit(state, seat, now)            finishNow(state)        (hard time cap)
     result(state) → null | { scores: number[] (higher is better), reason }
     shift(state, ms)                     (the server was down this long: move the clocks)
     capMs(n, opts)                       (the longest a match may run)                                              */
import * as chess from "./chess.js";
import * as poker from "./poker.js";

export const TABLE_GAMES = [
  {
    id: "chess", engine: chess, optsKey: "chess", minPlayers: 2, maxPlayers: 2,
    name: "Chess", category: "strategy", skill: 10, luck: 0, cashEligible: true, duration: "up to 25 min", scoreLabel: "result",
    blurb: "Classical chess against a friend, 5 minutes each plus 3 seconds a move. The server checks every move and keeps the clocks.",
    rules: [
      "Standard chess rules, including castling, en passant and promotion. The server checks every move.",
      "Colours are drawn at random. White moves first.",
      "Each player has 5 minutes plus 3 seconds per move. Run out of time and you lose, unless your opponent has nothing left to mate with.",
      "Checkmate wins. Stalemate, threefold repetition, the 50-move rule, insufficient material and an agreed draw are draws, and draws return every stake.",
      "Resigning (Forfeit) loses the game.",
    ],
  },
  {
    id: "poker", engine: poker, optsKey: "poker", minPlayers: 2, maxPlayers: 9,
    name: "Texas Hold'em", category: "cards", skill: 7, luck: 5, cashEligible: false, duration: "about 15–40 min", scoreLabel: "place",
    blurb: "No-limit hold'em for 2 to 9 players. Everyone starts with 1,500 chips; the last player with chips takes the pot.",
    rules: [
      "No-limit Texas Hold'em. Everyone starts with 1,500 chips, which are only for this table.",
      "Blinds start at 10/20 and go up every 3 minutes, so every game finishes.",
      "Every hand is dealt from a freshly shuffled deck. The shuffle uses the server's cryptographic random generator, and each deck's fingerprint is shown before the deal and revealed afterwards so you can check it.",
      "You have 25 seconds to act. Run out and you check if you can, otherwise fold.",
      "Lose all your chips and you are out. The last player with chips wins the whole pot, minus the fee.",
    ],
  },
];

export const tableGame = (id) => TABLE_GAMES.find((t) => t.id === id) || null;
