/* Per-game guide text for the game pages (views/gamelobby.js), keyed by game id.
   Every number here is taken from the full version of each game in src/games/*.js (the version online matches play).
   Shape: { tagline, overview, goal, length, scoring: [..], controls: [..], tips: [..] }, all plain strings. */
export const GAME_COPY = {
  sudoku: {
    tagline: "One unique sudoku, same for both. Solve it clean and fast.",
    overview: "A classic 9×9 sudoku with exactly one solution, built from the match seed so you and your opponent get the same grid. Every row, column and 3×3 box must hold 1 to 9. Good players solve steadily without guessing, because wrong numbers are costly and the clock pays for every second you save.",
    goal: "Higher score wins: finish the grid fast and with few mistakes. Equal scores are a draw and both stakes are returned.",
    length: "Up to 6 minutes",
    scoring: [
      "Solve the grid: 3,000 points, plus 5 for every second left on the clock.",
      "Each wrong number you entered takes 150 off a solved grid.",
      "Three wrong numbers end your run, and so does the clock running out.",
      "If the grid is not finished, you score 25 for each correct number you placed, with no deduction for mistakes.",
      "The puzzle starts with 31 to 36 numbers filled in, depending on the seed.",
    ],
    controls: [
      "Tap or click a cell, then tap a number on the keypad.",
      "Turn on Notes to pencil in candidates instead of entering a number.",
      "A wrong number shows in red; Erase clears it, or the notes in the selected cell.",
      "Keyboard: 1 to 9 to enter, arrow keys to move, Backspace, Delete or 0 to erase, N for Notes.",
    ],
    tips: [
      "One mistake costs 150, the same as 30 seconds of time bonus, so check before you commit.",
      "On two mistakes, slow down: a third ends the run and drops you to 25 per correct cell.",
      "Placing a correct number clears it from the notes in its row, column and box, so your notes stay tidy.",
      "The keypad counts how many of each digit are left, which helps you finish the last few cells quickly.",
    ],
  },

  mines: {
    tagline: "Same minefield, same safe start. Clear it by logic.",
    overview: "A 12×12 minefield hiding 22 mines, with the same layout and the same free start for both players. Numbers tell you how many mines touch each square, and you open every safe square without stepping on a mine. The board is generated to be cleared by logic wherever it can be, so careful reading usually beats guessing.",
    goal: "Higher score wins: a full clear, done quickly, is worth far more than a partial one. Equal scores are a draw and both stakes are returned.",
    length: "Up to 3 minutes",
    scoring: [
      "Clear every safe square: 2,000 points, plus 10 for every second left.",
      "Otherwise you score 10 for each safe square you have cleared.",
      "Hitting a mine ends the run straight away, and so does the clock running out.",
      "The free start opens by itself and its squares count towards your score.",
      "Flags score nothing on their own.",
    ],
    controls: [
      "Tap or click a square to reveal it.",
      "Right-click, long-press, or switch on Flag mode to plant or remove a flag.",
      "Tap a number that already has all its flags around it to open the rest of its neighbours.",
      "Zoom enlarges the board on small screens.",
      "Keyboard: arrow keys move, Space or Enter reveals, F flags.",
    ],
    tips: [
      "A full clear scores at least 2,000, while the 122 safe squares are worth 1,220 at most otherwise, so aim to finish.",
      "Opening neighbours from a number is the fastest way through the board, but one wrong flag next to it sets off a mine.",
      "If you are truly stuck, a guess only risks your remaining time: after a mine you keep 10 for every square already cleared.",
    ],
  },

  queens: {
    tagline: "One crown per row, column and colour. Solve all you can.",
    overview: "A logic puzzle on coloured grids: place one crown in every row, every column and every colour region, with no two crowns touching, not even diagonally. You solve as many grids as you can in 90 seconds, starting at 6×6 and moving up to 8×8. Both players get the same grids in the same order.",
    goal: "Higher score wins: solve more grids, and solve your last one sooner. Equal scores are a draw and both stakes are returned.",
    length: "90 seconds",
    scoring: [
      "Each solved grid scores 1,000 points.",
      "You add 10 points for every second that was left when you solved your most recent grid.",
      "When time runs out, the unfinished grid scores 100 for each crown on a correct square, minus 100 for each crown on a wrong one, never below 0.",
      "The grids go 6×6, then 7×7, then 8×8 for the rest of the run, 16 grids in all.",
    ],
    controls: [
      "Tap a square once for an ×, twice for a crown, and a third time to clear it.",
      "Crowns that break a rule turn red, and Clear board wipes the current grid.",
      "A grid counts as solved the moment the last correct crown goes down, and the next one loads by itself.",
      "Keyboard: arrow keys move between squares, Space or Enter marks the square.",
    ],
    tips: [
      "Start with the smallest regions and any region that sits in a single row or column, since they force a crown.",
      "After placing a crown, mark × on its row, column, region and the eight squares around it.",
      "A solved grid is worth 1,000, far more than the time bonus, so keep moving rather than rechecking.",
      "At the buzzer, remove crowns you are not sure of: each wrong crown cancels a right one.",
    ],
  },

  tiles2048: {
    tagline: "Slide, merge, score. Same tile drops for both of you.",
    overview: "The classic 2048 sliding puzzle on a 4×4 board, played against a 90-second clock. Every move slides all tiles one way, equal tiles merge into one, and a new 2 or 4 appears. New tiles come from the match seed, so the same moves give you and your opponent the same board.",
    goal: "Higher score wins: merge as much as you can before time runs out. Equal scores are a draw and both stakes are returned.",
    length: "90 seconds",
    scoring: [
      "Every merge adds the value of the new tile to your score, so two 8s merging score 16.",
      "Nothing else scores: your biggest tile and your move count do not add points.",
      "The run ends at 90 seconds, or earlier if no move is left, and your score stands.",
      "Each new tile is a 2 nine times in ten and a 4 otherwise, drawn in seeded order.",
    ],
    controls: [
      "Swipe on the board in any direction to slide the tiles.",
      "Keyboard: arrow keys or W, A, S, D.",
      "A move that changes nothing does not count and adds no tile.",
    ],
    tips: [
      "Keep your biggest tile in a corner and build the rest towards it so merges chain together.",
      "Time is short, so a steady pace of sensible moves scores more than long pauses.",
      "Avoid filling the board: if you run out of moves, you lose the time you had left.",
    ],
  },

  memory: {
    tagline: "Watch the squares light up, then repeat the order.",
    overview: "A sequence memory game: squares light up in order and you tap them back in the same order. Every level adds one more step, and after level 8 the grid grows from 3×3 to 4×4. Both players get the same sequence, so the longest clean run wins.",
    goal: "Higher score wins: go as far as you can and tap quickly once you are sure. Equal scores are a draw and both stakes are returned.",
    length: "Up to 4 minutes",
    scoring: [
      "You score 100 points for each step of the longest sequence you repeated correctly.",
      "Each cleared level also adds a speed bonus of up to 10 points per step.",
      "The full bonus needs an average of 0.5 seconds per tap or faster, and 1.5 seconds or slower earns nothing.",
      "One wrong tap ends the run, and you keep the points you have.",
      "Level 1 is 3 steps long, and the run stops at the 4-minute cap if you get that far.",
    ],
    controls: [
      "Watch while the squares light up, then tap or click them in the same order when it says Your turn.",
      "Keyboard on the 3×3 grid: 1 to 9, or Q, W, E, A, S, D, Z, X, C, row by row.",
      "Keyboard on the 4×4 grid: 1, 2, 3, 4, Q, W, E, R, A, S, D, F, Z, X, C, V, row by row.",
      "Each square shows its key.",
    ],
    tips: [
      "Each level replays the same sequence with one new step at the end, so you only need to add one square each time.",
      "Tap only when you are sure: one wrong square ends everything, and each new level adds 100 points plus its bonus.",
      "The speed clock starts at Your turn, so begin tapping straight away.",
    ],
  },

  base: {
    tagline: "Build a defence, then hold off 8 seeded zombie waves.",
    overview: "A tower defence game on a 12×9 map: you get 60 seconds and 300 gold to build walls, towers, traps and gold mines, then 8 waves of zombies walk the shortest route to your base. The map, the waves and the spawn points come from the seed, so your opponent faces exactly the same attack. Good players use walls to lengthen the route and pick towers that counter each zombie type.",
    goal: "Higher score wins: survive all 8 waves with as much base health and as many kills as you can. Equal scores are a draw and both stakes are returned.",
    length: "About 3 to 4 minutes: 60 s to build, then 8 waves",
    scoring: [
      "1,000 points for each wave your base survives.",
      "5 points for each point of base health left, out of 100.",
      "10 points for each zombie killed.",
      "Unspent gold scores a tenth of its value.",
      "Zombies that reach the base hit it for 5 (Walker), 3 (Runner), 15 (Brute) or 6 (Spitter).",
      "If a wave runs too long, every zombie still alive hits your base at once.",
      "The run ends when your base reaches 0 health or the eighth wave is over.",
    ],
    controls: [
      "Pick a tool from the bar, then tap or click a tile on the map to build there.",
      "Keys 1 to 6 pick Wall, Arrow, Cannon, Frost, Spikes and Mine; S is Sell, R is Repair, F is Firebomb.",
      "On a touch screen, anything costing 50 gold or more needs a second tap on the same tile to confirm.",
      "Tap a building to inspect it, then repair or sell it from the side panel; selling refunds the full price, but only before the first wave.",
      "Press Start waves or Enter when ready, or the waves start when the 60 s build timer ends; between waves you get 5 s to build or repair.",
      "You have 3 Firebombs for the whole game: during a wave, tap the map to hit a crowd for 35 plus 5 per wave number, with a 5 s cooldown.",
    ],
    tips: [
      "Walls cost only 10 gold, so use them to make the route longer past your towers; you can never block it completely, and Brutes smash through walls.",
      "Armour (1 on Walkers, 4 on Brutes) cuts every Arrow, Cannon and Firebomb hit, so Brutes take just 1 damage per arrow, while Frost and Spike damage ignores armour.",
      "Put Spike traps inside Frost range: slowed zombies stay on the spikes longer.",
      "Spitters stop to spit at towers and mines within reach, so repair between waves, and spend leftover gold before the last wave.",
    ],
  },

  city: {
    tagline: "Same plot, same budget. Build the best city in 90 s.",
    overview: "A city planning puzzle on a 7×7 plot with $10,000 to spend on homes, shops, factories, utilities and services. The plot, with its water and rock tiles, comes from the seed, so you and your opponent plan on the same ground. Good players balance homes with jobs, power and water, and keep pollution away from where people live.",
    goal: "Higher city score wins, to one decimal place. Equal scores are a draw and both stakes are returned.",
    length: "Up to 90 seconds",
    scoring: [
      "City score = People + Money + Growth, worked out from your finished layout.",
      "People is population × (happiness + 15) ÷ 690.",
      "Money is daily revenue ÷ 40, never lower than −40, where revenue is taxes, shop sales, factory output and stadium tickets minus upkeep of 4% of everything you built.",
      "Growth is the yearly growth rate × 3, or × 1 if the city is shrinking.",
      "Each home starts at 44 happiness, and parks (+7 each, up to 2), a hospital (+14), a school (+9), shops (+6), police (+5) and a stadium (+6) raise it.",
      "Pollution (−8 per point), crime, traffic, unemployment and power or water shortages lower it.",
      "There is no bonus for finishing early: the score depends only on your layout.",
    ],
    controls: [
      "Pick a building from the palette, then tap or click a tile to place it.",
      "Bulldoze removes a building for a full refund, and Undo reverses your last change.",
      "Keyboard: R homes, C shops, I factory, P park, E power, W water, T transit, H hospital, S school, X police, D stadium.",
      "B or Delete picks Bulldoze, and Ctrl+Z or Cmd+Z undoes.",
      "Hovering a tile with a building selected highlights the area it would reach, and each home shows its happiness.",
      "Press Finish city when you are happy; the plan locks automatically at 90 seconds.",
    ],
    tips: [
      "The city gets 3 power and 3 water from outside, and each home uses 1 of each, so add a Power plant and a Water tower before you run short.",
      "Keep Factories and Power plants at least 3 tiles from homes, or put a Park next to the homes to cancel some pollution.",
      "Half your residents want jobs, and unemployment costs up to 30 happiness, so pair homes with Shops, Factories or services.",
      "Cluster homes so one Hospital or Police station (reach 3) and one School, Park or Shop (reach 2) covers several of them.",
    ],
  },

  restaurant: {
    tagline: "Same $10,000, same 100 customers. Run the best day.",
    overview: "A restaurant management game: you have $10,000 and 60 seconds to choose a kitchen, tables, chefs, waiters, a menu of 3 to 5 dishes, a price level and a marketing spend. Then a day from 11:00 to 23:00 plays out with 100 customer groups from the seed, the same groups your opponent serves. Good players read the forecast and fit the menu, prices and staff to who is coming and when.",
    goal: "Higher score wins: make the most profit while keeping customers happy. Equal scores are a draw and both stakes are returned.",
    length: "About 1 minute: 60 s to plan, then the day plays out",
    scoring: [
      "Score = 5,000 + profit + reputation bonus, never below 0.",
      "Profit is revenue from food, drinks and tips, minus ingredients, wages, $150 setup per dish, marketing and 35% of the kitchen and table cost.",
      "The reputation bonus is 900 points for each review star above 3, or minus 900 for each star below.",
      "Every group served leaves a review based on how happy they were, and every group that leaves after waiting too long or finding nothing they want counts as a 1-star review.",
      "Groups who never come in do not review at all.",
    ],
    controls: [
      "Pick a kitchen: Basic (free, up to 2 chefs), Pro ($900, 1.3× speed, up to 4 chefs) or Elite ($2,600, 1.6× speed, up to 6 chefs).",
      "Use the + and − buttons for tables ($120, 4 seats each), chefs ($300), waiters ($180), prices (×0.70 to ×1.60) and marketing ($0 to $3,000 in steps of $250).",
      "Tap dishes to add them to the menu or take them off; you need 3 to 5.",
      "Press Open for the day when ready; when the 60 s run out, your current plan opens automatically.",
    ],
    tips: [
      "The projected score updates with every change and uses the same day you will get, so try options and keep what raises it.",
      "Check the forecast: Families and Students are price-sensitive, while Business guests and Foodies pay for quality.",
      "Groups who wait too long leave and drag your reviews down, so staff up for the rushes around 12:00 and 19:00.",
      "Kitchen and tables are charged at only 35% of their price, but wages, dish setup and marketing come off in full.",
    ],
  },

  reaction: {
    tagline: "Wait for gold, then tap. Jump early and the round is lost.",
    overview: "A pure reaction test over 5 rounds: you arm each round, wait for the pad to turn gold, then tap as fast as you can. The wait before gold is set by the seed, so both players get the same delays. Consistent fast reactions with no fouls win.",
    goal: "Higher total over 5 rounds wins. Equal scores are a draw and both stakes are returned.",
    length: "5 rounds, about 30 seconds",
    scoring: [
      "Each round scores 1,000 minus your reaction time in milliseconds, so 250 ms scores 750.",
      "Tapping before the pad turns gold is a foul and scores 0 for that round.",
      "Not tapping within 1 second of gold also scores 0.",
      "Your score is the total of all 5 rounds.",
    ],
    controls: [
      "Tap or click the pad, or press Space or Enter, to arm a round.",
      "When the pad turns gold, tap it or press Space or Enter.",
      "If you do not arm a round within 6 seconds, it arms by itself.",
    ],
    tips: [
      "The wait is anywhere from 1.2 to 3.8 seconds, so do not try to time it.",
      "A foul costs the whole round, far more than reacting 100 ms late, so never jump early.",
      "You arm each round yourself, so settle before you start the next one.",
    ],
  },

  aim: {
    tagline: "Targets pop up and shrink. Hit them fast, do not miss.",
    overview: "A 30-second aim test: targets appear, shrink, and vanish after 1.1 seconds. Both players get the same targets in the same places at the same times. Targets get smaller and come faster as the clock runs down.",
    goal: "Higher score wins: hit as many targets as you can, as early as you can. Equal scores are a draw and both stakes are returned.",
    length: "30 seconds",
    scoring: [
      "A hit scores 100 plus a speed bonus of up to 100 that falls to nothing over the target's 1.1-second life.",
      "A click or tap that hits no target costs 25 points.",
      "Your score never drops below 0.",
    ],
    controls: [
      "Click or tap a target to hit it.",
      "The gold ring around each target runs down as its time runs out.",
      "There are no keyboard controls.",
    ],
    tips: [
      "Do not click blindly: each miss costs 25, a quarter of even the slowest hit.",
      "When two targets are up, hit the older one first: it is about to vanish, and the newer one is still worth plenty.",
      "Targets shrink to under half their size before they vanish, so early hits are easier as well as worth more.",
    ],
  },

  rush: {
    tagline: "Quick-fire sums. Pick the right answer, keep the streak.",
    overview: "A 40-second mental arithmetic race where each sum has four possible answers. Problems start with addition and subtraction, then bring in multiplication and division and grow larger. Both players get the same problems in the same order.",
    goal: "Higher score wins: answer fast and keep your streak going. Equal scores are a draw and both stakes are returned.",
    length: "40 seconds",
    scoring: [
      "A correct answer scores 100, plus 10 for each earlier answer in your current streak, up to +50.",
      "That makes the sixth correct answer in a row, and every one after it, worth 150.",
      "A wrong answer costs 50 and resets your streak to zero.",
      "Your score never drops below 0.",
    ],
    controls: [
      "Tap or click one of the four answers, or press 1 to 4 on the keyboard.",
      "The next problem appears straight after each answer.",
    ],
    tips: [
      "A blind guess loses points on average: one in four right for 100, three in four wrong for −50.",
      "A wrong answer also wipes your streak bonus, so take care once you have a long streak.",
      "The first problems are the easiest, so use them to build your streak quickly.",
    ],
  },

  darts: {
    tagline: "Nine darts. Steady the sight, release on target.",
    overview: "A precision game with nine darts on a standard board. Your sight wobbles along a path set by the seed, the same path your opponent gets, and holding steadies it for a moment before your arm starts to shake. Good players aim for the treble 20 and release as the sight passes over it.",
    goal: "Higher total from nine darts wins. Equal scores are a draw and both stakes are returned.",
    length: "9 darts, up to 10 seconds each",
    scoring: [
      "Each dart scores its segment number, doubled in the outer ring and tripled in the inner ring.",
      "The bull scores 50, the outer bull 25, and anything outside the double ring scores 0.",
      "Your score is the total of all 9 darts, thrown in 3 visits of 3, so the maximum is 540.",
      "Each dart has a 10-second clock, and when it runs out the dart is thrown from wherever the sight is.",
    ],
    controls: [
      "Mouse: point at the board, press and hold to steady the sight, then release to throw.",
      "Touch: press and hold where you want to aim, with the sight just above your finger, slide to adjust and lift to throw.",
      "There are no keyboard controls.",
    ],
    tips: [
      "Holding shrinks the wobble to under half within about a second, but after 1.6 seconds your arm starts to shake again.",
      "The dashed circle shows how far the sight can wander from where you are pointing.",
      "Treble 20 is the best spot at 60, but the treble ring is narrow, so release as the sight crosses it.",
    ],
  },

  trivia: {
    tagline: "Ten questions. Right and fast beats right and slow.",
    overview: "A general knowledge quiz of 10 multiple-choice questions on geography, science, history, nature, sport, arts and language, maths and general topics. Both players get the same questions with the answers in the same order. Knowing the answer matters most, but speed decides close games.",
    goal: "Higher score wins: answer correctly and quickly. Equal scores are a draw and both stakes are returned.",
    length: "10 questions, 12 seconds each",
    scoring: [
      "A correct answer scores 100 plus a speed bonus of up to 50, based on how much of the 12 seconds is left.",
      "A wrong answer or a time-out scores 0, with no penalty.",
      "The quiz has at most 2 questions from any one category, with a spread of easy, medium and hard questions.",
    ],
    controls: [
      "Tap or click an answer, or press 1 to 4 on the keyboard.",
      "Your first answer counts and cannot be changed; the correct answer is shown before the next question.",
    ],
    tips: [
      "Never let the clock run out: a wrong answer costs nothing, so a guess is free.",
      "The speed bonus is at most 50, so take a moment to be sure rather than rush a wrong answer.",
      "Rule out the answers you know are wrong, then choose from what is left.",
    ],
  },

  groups: {
    tagline: "Sixteen words, four hidden groups. Find them all.",
    overview: "A word puzzle with 16 words that form four groups of four. You select four words you think share a link and submit them, and both players get the same puzzle. The trickiest group is usually wordplay, such as words that go with the same word or hide another word inside.",
    goal: "Higher score wins: find more groups, the harder ones especially, with few mistakes. Equal scores are a draw and both stakes are returned.",
    length: "Up to 3 minutes",
    scoring: [
      "Groups are worth 200, 250, 300 and 350 points, from the easiest (yellow) to the trickiest (purple).",
      "Each wrong guess costs 50 points, and the fourth wrong guess ends the game.",
      "Finding all four groups adds a time bonus of up to 300, based on how much of the 3 minutes is left.",
      "Your score never drops below 0.",
      "Submitting the same four words twice does not count as another mistake.",
    ],
    controls: [
      "Tap or click four words to select them, then press Submit or Enter.",
      "Deselect clears your selection, and Shuffle rearranges the remaining words.",
      "One away means three of your four words belong to the same group.",
    ],
    tips: [
      "Finding all four groups with 2 minutes left adds 200 bonus points, so speed matters once you are close.",
      "Watch for decoy words that fit more than one group before you submit.",
      "If you see One away, swap a single word rather than starting again.",
      "Shuffle when you are stuck: seeing the words in a new order can reveal a link.",
    ],
  },
};

export const copyFor = (id) => GAME_COPY[id] || null;
