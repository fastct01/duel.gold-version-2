/* Duel.gold — Pack E: KNOWLEDGE, WORD, CARDS, DICE, SOCIAL (pack 'social')
   Games: trivia (race), groups (race), durak (versus), liars (versus), auction (versus). */
(function () {
  "use strict";
  const U = DG.util;
  const esc = U.esc;
  const clamp = U.clamp;
  const money = (n) => "$" + U.fmt(n);
  /* Sentence subject with verb agreement: the human is addressed as "You" (second person), others by name. */
  const subj = (name, you, verb) => (you ? "You " + verb.replace(/^(\w+?)s\b/, "$1") : name + " " + verb);
  const short = (n) => (String(n).length > 12 ? String(n).slice(0, 11) + "…" : String(n));
  const clock = (s) => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };

  /* =====================================================================
     1. TRIVIA DUEL
     ===================================================================== */
  const TV_CATS = { GEO: "Geography", SCI: "Science", HIS: "History", NAT: "Nature", SPO: "Sport", ART: "Arts & Language", MAT: "Maths", GEN: "General" };
  /* [category, difficulty 1-3, question, correct, wrong1, wrong2, wrong3] — timeless facts only. */
  const TV_RAW = [
    // Geography
    ["GEO", 1, "What is the capital of Japan?", "Tokyo", "Kyoto", "Osaka", "Hiroshima"],
    ["GEO", 1, "Which is the largest ocean on Earth?", "Pacific", "Atlantic", "Indian", "Arctic"],
    ["GEO", 1, "On which continent is the Sahara Desert?", "Africa", "Asia", "Australia", "South America"],
    ["GEO", 1, "Which river flows through Paris?", "Seine", "Thames", "Danube", "Rhine"],
    ["GEO", 2, "What is the capital of Australia?", "Canberra", "Sydney", "Melbourne", "Perth"],
    ["GEO", 2, "What is the capital of Canada?", "Ottawa", "Toronto", "Vancouver", "Montreal"],
    ["GEO", 2, "What is the capital of Turkey?", "Ankara", "Istanbul", "Izmir", "Antalya"],
    ["GEO", 1, "Which is the largest country in the world by area?", "Russia", "Canada", "China", "United States"],
    ["GEO", 2, "In which country is Mount Kilimanjaro?", "Tanzania", "Kenya", "Uganda", "Ethiopia"],
    ["GEO", 2, "Which strait separates Spain from Morocco?", "Strait of Gibraltar", "Strait of Hormuz", "Bosporus", "Strait of Dover"],
    ["GEO", 1, "Which mountain range runs along the western side of South America?", "Andes", "Alps", "Himalayas", "Rockies"],
    ["GEO", 2, "What is the capital of New Zealand?", "Wellington", "Auckland", "Christchurch", "Queenstown"],
    ["GEO", 3, "What is the capital of Morocco?", "Rabat", "Casablanca", "Marrakesh", "Fez"],
    ["GEO", 2, "Which canal links the Mediterranean Sea and the Red Sea?", "Suez Canal", "Panama Canal", "Kiel Canal", "Corinth Canal"],
    ["GEO", 3, "Which is the deepest lake in the world?", "Lake Baikal", "Lake Superior", "Lake Victoria", "Lake Tanganyika"],
    ["GEO", 1, "What is the smallest country in the world by area?", "Vatican City", "Monaco", "San Marino", "Liechtenstein"],
    ["GEO", 3, "The city of Istanbul lies on both banks of which strait?", "Bosporus", "Dardanelles", "Strait of Messina", "Strait of Gibraltar"],
    ["GEO", 2, "What is the capital of Peru?", "Lima", "Quito", "Bogotá", "Santiago"],
    ["GEO", 1, "Which country is shaped like a boot?", "Italy", "Greece", "Spain", "Portugal"],
    ["GEO", 3, "Which is the largest island in the world (not counting continents)?", "Greenland", "New Guinea", "Borneo", "Madagascar"],
    ["GEO", 2, "Which river flows through Budapest?", "Danube", "Vistula", "Elbe", "Volga"],
    ["GEO", 1, "What is the capital of Egypt?", "Cairo", "Alexandria", "Luxor", "Aswan"],
    ["GEO", 3, "What is the capital of Vietnam?", "Hanoi", "Ho Chi Minh City", "Da Nang", "Hue"],
    ["GEO", 2, "Mont Blanc is the highest peak of which mountain range?", "Alps", "Pyrenees", "Carpathians", "Apennines"],
    // Science
    ["SCI", 1, "What is the chemical symbol for gold?", "Au", "Ag", "Gd", "Go"],
    ["SCI", 1, "Which planet is known as the Red Planet?", "Mars", "Venus", "Jupiter", "Mercury"],
    ["SCI", 1, "What is the largest planet in our Solar System?", "Jupiter", "Saturn", "Neptune", "Earth"],
    ["SCI", 1, "At sea level, pure water boils at what temperature?", "100 °C", "90 °C", "110 °C", "120 °C"],
    ["SCI", 2, "What is the chemical symbol for sodium?", "Na", "So", "Sd", "S"],
    ["SCI", 2, "Which gas makes up most of Earth's atmosphere?", "Nitrogen", "Oxygen", "Carbon dioxide", "Argon"],
    ["SCI", 1, "Which planet is closest to the Sun?", "Mercury", "Venus", "Mars", "Earth"],
    ["SCI", 2, "How many bones are in a typical adult human body?", "206", "186", "226", "256"],
    ["SCI", 1, "What is the hardest natural substance?", "Diamond", "Quartz", "Granite", "Iron"],
    ["SCI", 2, "Which element has atomic number 1?", "Hydrogen", "Helium", "Oxygen", "Carbon"],
    ["SCI", 2, "What is the SI unit of force?", "Newton", "Joule", "Watt", "Pascal"],
    ["SCI", 2, "What does a light-year measure?", "Distance", "Time", "Brightness", "Speed"],
    ["SCI", 3, "Absolute zero is closest to which temperature?", "−273 °C", "−100 °C", "−459 °C", "−173 °C"],
    ["SCI", 2, "Which part of a cell is known as its powerhouse?", "Mitochondria", "Nucleus", "Ribosome", "Cell membrane"],
    ["SCI", 1, "Which gas do plants take in from the air for photosynthesis?", "Carbon dioxide", "Oxygen", "Nitrogen", "Hydrogen"],
    ["SCI", 2, "Who discovered penicillin?", "Alexander Fleming", "Louis Pasteur", "Marie Curie", "Joseph Lister"],
    ["SCI", 3, "Who published the first widely recognised periodic table of the elements?", "Dmitri Mendeleev", "John Dalton", "Antoine Lavoisier", "Niels Bohr"],
    ["SCI", 3, "What is the chemical symbol for potassium?", "K", "P", "Po", "Pt"],
    ["SCI", 1, "What is the pH of pure water at 25 °C?", "7", "0", "5", "14"],
    ["SCI", 3, "What is the approximate speed of light in a vacuum?", "300,000 km/s", "30,000 km/s", "3,000,000 km/s", "3,000 km/s"],
    ["SCI", 2, "Which planet has the hottest surface in our Solar System?", "Venus", "Mercury", "Mars", "Jupiter"],
    ["SCI", 2, "What is the largest organ of the human body?", "Skin", "Liver", "Brain", "Lungs"],
    ["SCI", 2, "Which unit measures electrical resistance?", "Ohm", "Volt", "Ampere", "Watt"],
    ["SCI", 1, "Which scientist developed the theory of general relativity?", "Albert Einstein", "Isaac Newton", "Niels Bohr", "Max Planck"],
    ["SCI", 3, "What is the most abundant element in the universe?", "Hydrogen", "Helium", "Oxygen", "Carbon"],
    ["SCI", 2, "Sound cannot travel through which of these?", "A vacuum", "Water", "Steel", "Air"],
    // History
    ["HIS", 1, "In which year did the Second World War end?", "1945", "1944", "1946", "1939"],
    ["HIS", 1, "Who was the first person to walk on the Moon?", "Neil Armstrong", "Buzz Aldrin", "Yuri Gagarin", "John Glenn"],
    ["HIS", 1, "In which year did Christopher Columbus first reach the Americas?", "1492", "1502", "1488", "1519"],
    ["HIS", 2, "In which year did the First World War begin?", "1914", "1912", "1916", "1918"],
    ["HIS", 2, "In which year did the Berlin Wall fall?", "1989", "1991", "1987", "1985"],
    ["HIS", 2, "Who was the first human to travel into space?", "Yuri Gagarin", "Neil Armstrong", "Alan Shepard", "Valentina Tereshkova"],
    ["HIS", 2, "Which country launched Sputnik 1, the first artificial satellite?", "Soviet Union", "United States", "United Kingdom", "France"],
    ["HIS", 2, "In which year did the French Revolution begin?", "1789", "1776", "1799", "1815"],
    ["HIS", 3, "In which year was Magna Carta sealed?", "1215", "1066", "1314", "1415"],
    ["HIS", 2, "In which year was the Battle of Hastings fought?", "1066", "1215", "966", "1166"],
    ["HIS", 2, "At which battle was Napoleon finally defeated in 1815?", "Waterloo", "Austerlitz", "Trafalgar", "Borodino"],
    ["HIS", 1, "In which year did the Titanic sink?", "1912", "1905", "1915", "1921"],
    ["HIS", 2, "Who was the first emperor of Rome?", "Augustus", "Julius Caesar", "Nero", "Constantine"],
    ["HIS", 2, "Who introduced movable-type printing to Europe around 1440?", "Johannes Gutenberg", "Leonardo da Vinci", "William Caxton", "Galileo Galilei"],
    ["HIS", 3, "In which year did Constantinople fall to the Ottoman Empire?", "1453", "1492", "1204", "1389"],
    ["HIS", 2, "In which country did the Renaissance begin?", "Italy", "France", "England", "Spain"],
    ["HIS", 3, "What was the capital city of the Aztec Empire?", "Tenochtitlan", "Cusco", "Machu Picchu", "Teotihuacan"],
    ["HIS", 1, "In which year did the United States declare independence?", "1776", "1789", "1812", "1492"],
    ["HIS", 2, "In which year was Nelson Mandela released from prison?", "1990", "1985", "1994", "1978"],
    ["HIS", 3, "In which year was Julius Caesar assassinated?", "44 BC", "27 BC", "AD 14", "AD 64"],
    ["HIS", 2, "The Vikings came mainly from which region?", "Scandinavia", "Iberia", "The Balkans", "North Africa"],
    ["HIS", 3, "Which queen ruled England from 1558 to 1603?", "Elizabeth I", "Mary I", "Victoria", "Anne"],
    ["HIS", 2, "In which year did the October Revolution take place in Russia?", "1917", "1923", "1921", "1914"],
    ["HIS", 3, "Which ancient wonder stood at the harbour of Rhodes?", "The Colossus", "The Lighthouse", "The Hanging Gardens", "The Mausoleum"],
    // Nature
    ["NAT", 1, "What is the largest animal living today?", "Blue whale", "African elephant", "Whale shark", "Sperm whale"],
    ["NAT", 1, "What is the fastest land animal?", "Cheetah", "Lion", "Pronghorn", "Greyhound"],
    ["NAT", 1, "How many legs does a spider have?", "8", "6", "10", "12"],
    ["NAT", 1, "What is the tallest living animal?", "Giraffe", "Elephant", "Ostrich", "Camel"],
    ["NAT", 1, "What do giant pandas mainly eat?", "Bamboo", "Eucalyptus", "Fish", "Berries"],
    ["NAT", 2, "What is a group of lions called?", "A pride", "A pack", "A herd", "A school"],
    ["NAT", 2, "How many hearts does an octopus have?", "3", "1", "2", "4"],
    ["NAT", 1, "What is the largest living bird?", "Ostrich", "Emu", "Albatross", "Condor"],
    ["NAT", 2, "Which are the only mammals capable of true flight?", "Bats", "Flying squirrels", "Sugar gliders", "Flying lemurs"],
    ["NAT", 1, "What is a baby kangaroo called?", "Joey", "Kit", "Cub", "Calf"],
    ["NAT", 2, "What do koalas mainly eat?", "Eucalyptus leaves", "Bamboo", "Grass", "Insects"],
    ["NAT", 1, "What is a young frog called?", "Tadpole", "Fry", "Kit", "Cub"],
    ["NAT", 2, "Which is the largest rainforest in the world?", "Amazon", "Congo", "Daintree", "Borneo"],
    ["NAT", 1, "Which is the highest mountain above sea level?", "Mount Everest", "K2", "Kangchenjunga", "Mont Blanc"],
    ["NAT", 3, "Which ocean trench contains the deepest known point on Earth?", "Mariana Trench", "Puerto Rico Trench", "Java Trench", "Tonga Trench"],
    ["NAT", 2, "What is the largest hot desert in the world?", "Sahara", "Gobi", "Kalahari", "Atacama"],
    ["NAT", 2, "What is a male honey bee called?", "Drone", "Worker", "Queen", "Jack"],
    ["NAT", 1, "What does a caterpillar turn into?", "A butterfly or moth", "A beetle", "A dragonfly", "A bee"],
    ["NAT", 3, "Which part of a plant cell carries out photosynthesis?", "Chloroplast", "Nucleus", "Vacuole", "Cell wall"],
    ["NAT", 2, "How many legs does an insect have?", "6", "4", "8", "10"],
    ["NAT", 3, "What is a group of crows called?", "A murder", "A parliament", "A gaggle", "A pod"],
    ["NAT", 3, "Which of these animals is a marsupial?", "Wombat", "Armadillo", "Hedgehog", "Otter"],
    ["NAT", 1, "Which of these animals is a mammal?", "Dolphin", "Shark", "Salmon", "Octopus"],
    ["NAT", 2, "Which living bird lays the largest eggs?", "Ostrich", "Emu", "Albatross", "Penguin"],
    // Sport
    ["SPO", 1, "How many players does a football (soccer) team have on the pitch?", "11", "10", "9", "12"],
    ["SPO", 1, "How many players does a basketball team have on the court?", "5", "6", "7", "4"],
    ["SPO", 2, "How many players does an indoor volleyball team have on the court?", "6", "5", "7", "8"],
    ["SPO", 1, "How many rings are on the Olympic flag?", "5", "4", "6", "7"],
    ["SPO", 2, "What is the official distance of a marathon?", "42.195 km", "40 km", "42 km", "45.5 km"],
    ["SPO", 1, "In tennis, which word means a score of zero?", "Love", "Nil", "Duck", "Blank"],
    ["SPO", 2, "In golf, what is one stroke under par called?", "Birdie", "Eagle", "Bogey", "Albatross"],
    ["SPO", 2, "In golf, what is one stroke over par called?", "Bogey", "Birdie", "Eagle", "Condor"],
    ["SPO", 1, "Which chess piece moves in an L shape?", "Knight", "Bishop", "Rook", "Queen"],
    ["SPO", 2, "In cricket, how many legal deliveries make up a standard over?", "6", "5", "8", "10"],
    ["SPO", 2, "In snooker, which coloured ball is worth the most points?", "Black", "Pink", "Blue", "Brown"],
    ["SPO", 2, "What is the highest score possible with three darts?", "180", "150", "160", "200"],
    ["SPO", 2, "What is a perfect score in ten-pin bowling?", "300", "200", "250", "100"],
    ["SPO", 1, "In which country were the ancient Olympic Games held?", "Greece", "Italy", "Egypt", "Turkey"],
    ["SPO", 2, "On which surface is the Wimbledon tennis championship played?", "Grass", "Clay", "Hard court", "Carpet"],
    ["SPO", 3, "How high is a standard basketball hoop above the floor?", "3.05 m (10 ft)", "2.75 m (9 ft)", "3.35 m (11 ft)", "3.65 m (12 ft)"],
    ["SPO", 1, "What do badminton players hit instead of a ball?", "A shuttlecock", "A puck", "A disc", "A bean bag"],
    ["SPO", 2, "How many players does a rugby union team have on the pitch?", "15", "13", "11", "12"],
    ["SPO", 1, "In which sport would you perform a slam dunk?", "Basketball", "Volleyball", "Handball", "Water polo"],
    ["SPO", 2, "Sumo wrestling comes from which country?", "Japan", "China", "Korea", "Thailand"],
    ["SPO", 1, "The Tour de France is a race in which sport?", "Cycling", "Motor racing", "Sailing", "Running"],
    ["SPO", 3, "How many players does one ice hockey team have on the ice during normal play?", "6", "5", "7", "11"],
    ["SPO", 3, "In baseball, how many strikes make a strikeout?", "3", "4", "2", "5"],
    // Arts & Language
    ["ART", 1, "Who painted the Mona Lisa?", "Leonardo da Vinci", "Michelangelo", "Raphael", "Rembrandt"],
    ["ART", 1, "Who wrote \"Romeo and Juliet\"?", "William Shakespeare", "Charles Dickens", "Christopher Marlowe", "Jane Austen"],
    ["ART", 2, "Who wrote \"War and Peace\"?", "Leo Tolstoy", "Fyodor Dostoevsky", "Anton Chekhov", "Ivan Turgenev"],
    ["ART", 2, "Who painted \"The Starry Night\"?", "Vincent van Gogh", "Claude Monet", "Paul Cézanne", "Edvard Munch"],
    ["ART", 2, "Who painted the ceiling of the Sistine Chapel?", "Michelangelo", "Leonardo da Vinci", "Raphael", "Botticelli"],
    ["ART", 2, "Who composed the \"Moonlight\" Sonata?", "Ludwig van Beethoven", "Wolfgang Amadeus Mozart", "Frédéric Chopin", "Johann Sebastian Bach"],
    ["ART", 2, "Who composed the music for the ballet \"Swan Lake\"?", "Pyotr Tchaikovsky", "Sergei Prokofiev", "Igor Stravinsky", "Nikolai Rimsky-Korsakov"],
    ["ART", 2, "Who wrote \"Pride and Prejudice\"?", "Jane Austen", "Charlotte Brontë", "Emily Brontë", "George Eliot"],
    ["ART", 2, "Who wrote \"Don Quixote\"?", "Miguel de Cervantes", "Lope de Vega", "Gabriel García Márquez", "Dante Alighieri"],
    ["ART", 1, "How many letters are in the English alphabet?", "26", "24", "28", "25"],
    ["ART", 2, "How many lines does a traditional sonnet have?", "14", "12", "10", "16"],
    ["ART", 1, "What is the plural of \"mouse\" (the animal)?", "Mice", "Mouses", "Meese", "Mousen"],
    ["ART", 2, "What does the Latin phrase \"carpe diem\" mean?", "Seize the day", "Love conquers all", "I came, I saw, I conquered", "Know yourself"],
    ["ART", 2, "Who wrote \"Crime and Punishment\"?", "Fyodor Dostoevsky", "Leo Tolstoy", "Nikolai Gogol", "Alexander Pushkin"],
    ["ART", 3, "Who painted \"The Scream\"?", "Edvard Munch", "Gustav Klimt", "Egon Schiele", "Wassily Kandinsky"],
    ["ART", 2, "Which ancient Greek poet is credited with \"The Odyssey\"?", "Homer", "Sophocles", "Virgil", "Ovid"],
    ["ART", 2, "The haiku is a short poetic form from which country?", "Japan", "China", "Korea", "India"],
    ["ART", 2, "What do you call a word that reads the same backwards as forwards?", "Palindrome", "Anagram", "Homophone", "Acronym"],
    ["ART", 3, "Who wrote \"Les Misérables\"?", "Victor Hugo", "Alexandre Dumas", "Gustave Flaubert", "Émile Zola"],
    ["ART", 2, "How many keys does a standard modern piano have?", "88", "76", "92", "84"],
    ["ART", 2, "How many strings does a standard violin have?", "4", "5", "6", "3"],
    ["ART", 3, "Who sculpted \"The Thinker\"?", "Auguste Rodin", "Michelangelo", "Donatello", "Antonio Canova"],
    ["ART", 3, "Who painted \"Guernica\"?", "Pablo Picasso", "Salvador Dalí", "Joan Miró", "Francisco Goya"],
    ["ART", 1, "Which of these languages is written in the Cyrillic alphabet?", "Russian", "Polish", "Hungarian", "Greek"],
    ["ART", 3, "Who composed the opera \"The Magic Flute\"?", "Wolfgang Amadeus Mozart", "Giuseppe Verdi", "Richard Wagner", "Joseph Haydn"],
    // Maths
    ["MAT", 1, "What is 7 × 8?", "56", "54", "48", "64"],
    ["MAT", 1, "What is the square root of 144?", "12", "14", "11", "16"],
    ["MAT", 1, "What do the interior angles of a triangle add up to?", "180°", "360°", "90°", "270°"],
    ["MAT", 1, "How many sides does a hexagon have?", "6", "5", "7", "8"],
    ["MAT", 2, "What is 15% of 200?", "30", "15", "20", "35"],
    ["MAT", 2, "What is 2 to the power of 10?", "1,024", "1,000", "2,048", "512"],
    ["MAT", 1, "What is the smallest prime number?", "2", "1", "3", "0"],
    ["MAT", 2, "Which number does the Roman numeral L stand for?", "50", "100", "500", "5"],
    ["MAT", 2, "Which number does the Roman numeral XL stand for?", "40", "60", "90", "400"],
    ["MAT", 2, "How many edges does a cube have?", "12", "8", "6", "10"],
    ["MAT", 2, "What is 5! (5 factorial)?", "120", "25", "60", "720"],
    ["MAT", 1, "What is 0.25 as a fraction?", "1/4", "1/5", "2/5", "1/3"],
    ["MAT", 2, "What is the sum of the whole numbers from 1 to 10?", "55", "50", "45", "65"],
    ["MAT", 2, "A right-angled triangle has shorter sides of 3 and 4. How long is the longest side?", "5", "6", "7", "4.5"],
    ["MAT", 3, "The binary number 101 equals which decimal number?", "5", "3", "6", "4"],
    ["MAT", 1, "How many degrees are in a full circle?", "360", "180", "400", "100"],
    ["MAT", 2, "What is 3 cubed?", "27", "9", "81", "18"],
    ["MAT", 2, "What is the next prime number after 13?", "17", "15", "19", "21"],
    ["MAT", 3, "What is 17 × 6?", "102", "96", "112", "108"],
    ["MAT", 2, "How many seconds are in one hour?", "3,600", "360", "6,000", "1,440"],
    ["MAT", 3, "What is the area of a circle with radius r?", "πr²", "2πr", "πd", "r²/π"],
    ["MAT", 3, "Which of these numbers is NOT prime?", "91", "89", "97", "83"],
    ["MAT", 3, "What is 1/8 as a decimal?", "0.125", "0.8", "0.18", "0.0125"],
    ["MAT", 1, "How many faces does a cube have?", "6", "8", "12", "4"],
    // General
    ["GEN", 1, "How many days are in a leap year?", "366", "365", "364", "367"],
    ["GEN", 1, "How many cards are in a standard deck without jokers?", "52", "54", "48", "50"],
    ["GEN", 1, "How many years are in a century?", "100", "10", "1,000", "50"],
    ["GEN", 2, "How many months of the year have 31 days?", "7", "6", "5", "8"],
    ["GEN", 1, "In which city is the Eiffel Tower?", "Paris", "Lyon", "Brussels", "Marseille"],
    ["GEN", 2, "Which country gave the Statue of Liberty to the United States?", "France", "United Kingdom", "Spain", "Italy"],
    ["GEN", 2, "In which Indian city is the Taj Mahal?", "Agra", "Delhi", "Mumbai", "Jaipur"],
    ["GEN", 1, "In which city is the Colosseum?", "Rome", "Athens", "Naples", "Florence"],
    ["GEN", 2, "What is the currency of Japan?", "Yen", "Won", "Yuan", "Ringgit"],
    ["GEN", 2, "What is the main language spoken in Brazil?", "Portuguese", "Spanish", "French", "English"],
    ["GEN", 3, "What is the traditional gift for a 25th wedding anniversary?", "Silver", "Gold", "Paper", "Diamond"],
    ["GEN", 2, "How many signs are in the Western zodiac?", "12", "10", "13", "9"],
    ["GEN", 1, "On a vertical traffic light, which colour is at the top?", "Red", "Green", "Amber", "Blue"],
    ["GEN", 2, "How many years are in a millennium?", "1,000", "100", "10,000", "500"],
    ["GEN", 2, "Which three-letter Morse code signal is the famous call for help?", "SOS", "SAS", "HLP", "MAY"],
    ["GEN", 1, "How many hours are in a day?", "24", "12", "20", "36"],
    ["GEN", 2, "How many small squares make up a standard chessboard?", "64", "81", "49", "100"],
    ["GEN", 2, "Red Square is in which city?", "Moscow", "St Petersburg", "Minsk", "Prague"],
    ["GEN", 3, "How many is a baker's dozen?", "13", "12", "14", "11"],
    ["GEN", 1, "How many faces does a standard gaming die have?", "6", "4", "8", "12"],
    ["GEN", 3, "What is the nickname of the great bell of the clock at the Palace of Westminster?", "Big Ben", "Liberty Bell", "Tsar Bell", "Old Tom"],
    ["GEN", 2, "Roughly how many weeks are in a year?", "52", "48", "50", "56"],
    ["GEN", 3, "Which planet is named after the Roman god of the sea?", "Neptune", "Saturn", "Uranus", "Mars"],
    ["GEN", 1, "What do we call water in its frozen form?", "Ice", "Steam", "Dew", "Mist"],
  ];
  const TRIVIA = TV_RAW.map((a) => ({ c: a[0], d: a[1], q: a[2], a: a[3], w: [a[4], a[5], a[6]] }));

  const tvCfg = (mode) => (mode === "mix" ? { n: 5, T: 8, reveal: 1.0 } : { n: 10, T: 12, reveal: 1.8 });
  function triviaSet(seed, mode) {
    const cfg = tvCfg(mode), rng = U.rng(seed + ":trivia:" + mode);
    const order = U.shuffle(rng, TRIVIA.map((_, i) => i));
    const catCap = mode === "mix" ? 1 : 2;
    const dCap = mode === "mix" ? { 1: 2, 2: 2, 3: 1 } : { 1: 3, 2: 4, 3: 3 };
    const picked = [], cc = {}, dc = { 1: 0, 2: 0, 3: 0 };
    for (const i of order) {
      if (picked.length >= cfg.n) break;
      const q = TRIVIA[i];
      if ((cc[q.c] || 0) >= catCap || dc[q.d] >= dCap[q.d]) continue;
      picked.push(i); cc[q.c] = (cc[q.c] || 0) + 1; dc[q.d]++;
    }
    for (const i of order) { if (picked.length >= cfg.n) break; if (!picked.includes(i)) picked.push(i); }
    return picked.map((i) => {
      const q = TRIVIA[i], opts = U.shuffle(rng, [q.a].concat(q.w));
      return { id: i, c: q.c, d: q.d, q: q.q, opts, ans: opts.indexOf(q.a) };
    });
  }
  const tvPoints = (left, T) => 100 + Math.round(50 * clamp(left / T, 0, 1));

  DG.css("trivia", `
    .g-trivia{display:grid;gap:12px}
    .g-trivia-top{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap}
    .g-trivia-score{font-family:var(--f-mono);font-weight:700;color:var(--gold)}
    .g-trivia-bar{height:8px;border-radius:99px;background:var(--panel-2);overflow:hidden;border:1px solid var(--line)}
    .g-trivia-bar i{display:block;height:100%;width:100%;background:var(--gold);transform-origin:left center}
    .g-trivia-bar.low i{background:var(--warn)}
    .g-trivia-q{font-size:clamp(18px,4.6vw,24px);font-weight:700;line-height:1.3;min-height:3.2em;margin:4px 0 0;text-wrap:balance}
    .g-trivia-opts{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    @media (max-width:520px){.g-trivia-opts{grid-template-columns:1fr}}
    .g-trivia-opt{display:flex;align-items:center;gap:10px;text-align:left;min-height:52px;padding:10px 12px;border-radius:var(--r-md);
      background:var(--panel-2);border:1px solid var(--line);font-weight:600;font-size:16px;line-height:1.25}
    .g-trivia-opt:hover:not(:disabled){background:var(--panel-3)}
    .g-trivia-opt b{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:6px;background:var(--panel);font-family:var(--f-mono);font-size:13px;color:var(--muted)}
    .g-trivia-opt:disabled{cursor:default}
    .g-trivia-opt.ok{border-color:var(--good);background:color-mix(in srgb,var(--good) 20%,var(--panel-2));color:var(--fg)}
    .g-trivia-opt.ok b{background:var(--good);color:#08240F}
    .g-trivia-opt.bad{border-color:var(--bad);background:color-mix(in srgb,var(--bad) 18%,var(--panel-2))}
    .g-trivia-opt.dim{opacity:.55}
    .g-trivia-fb{min-height:24px;font-weight:700;text-align:center}
    .g-trivia-dots{display:flex;gap:5px;flex-wrap:wrap}
    .g-trivia-dots i{width:10px;height:10px;border-radius:50%;background:var(--panel-3);border:1px solid var(--line)}
    .g-trivia-dots i.ok{background:var(--good);border-color:var(--good)} .g-trivia-dots i.bad{background:var(--bad);border-color:var(--bad)}
    .g-trivia-dots i.cur{border-color:var(--gold);box-shadow:0 0 0 2px color-mix(in srgb,var(--gold) 40%,transparent)}
  `);

  DG.registerGame({
    id: "trivia", name: "Trivia Duel", category: "knowledge", kind: "race",
    formats: ["1v1", "2v2", "ffa", "tournament", "mix"],
    skill: 7, luck: 3, cashEligible: false, duration: "up to 2.5 min", pack: "social", // 10 × (12 s + 1.8 s reveal)
    blurb: "Ten multiple-choice questions. Right and fast beats right and slow.",
    rules: [
      "Everyone gets the same questions in the same order.",
      "Each question has four options and a 12-second clock (8 s in Duel Mix).",
      "A correct answer scores 100 points plus up to 50 for speed.",
      "Wrong answers and time-outs score nothing. The correct answer is shown after each question.",
      "Keys 1–4 pick an answer.",
    ],
    scoreLabel: "pts",
    play(ctx) {
      const cfg = tvCfg(ctx.mode), qs = triviaSet(ctx.seed, ctx.mode);
      let qi = -1, score = 0, correct = 0, phase = "idle", qStart = 0;
      const marks = [];
      ctx.root.innerHTML = `<div class="g-trivia" data-test="trivia">
        <div class="g-trivia-top"><span class="dg-eyebrow" data-test="tv-head"></span><span class="g-trivia-score" data-test="tv-score">0 pts</span></div>
        <div class="g-trivia-dots"></div>
        <div class="g-trivia-bar"><i></i></div>
        <p class="g-trivia-q" data-test="tv-q"></p>
        <div class="g-trivia-opts"></div>
        <div class="g-trivia-fb" data-test="tv-fb" aria-live="polite"></div>
        <p class="dg-note dg-center" style="margin:0">Tap the right answer. Faster answers earn up to +50.</p></div>`;
      const $ = (s) => ctx.root.querySelector(s);
      const bar = $(".g-trivia-bar"), barI = bar.querySelector("i");
      const dots = () => { $(".g-trivia-dots").innerHTML = qs.map((_, i) => `<i class="${marks[i] || (i === qi ? "cur" : "")}"></i>`).join(""); };

      function next() {
        qi++;
        if (qi >= qs.length) return finish();
        const q = qs[qi];
        phase = "ask"; qStart = ctx.now();
        $("[data-test=tv-head]").textContent = `Question ${qi + 1} / ${qs.length} · ${TV_CATS[q.c]}`;
        $("[data-test=tv-q]").textContent = q.q;
        $(".g-trivia-opts").innerHTML = q.opts.map((o, i) =>
          `<button class="g-trivia-opt" data-test="tv-opt" data-i="${i}"><b>${i + 1}</b><span>${esc(o)}</span></button>`).join("");
        ctx.root.querySelectorAll(".g-trivia-opt").forEach((b) => b.addEventListener("click", () => answer(+b.dataset.i)));
        $("[data-test=tv-fb]").textContent = "";
        dots(); tick();
      }
      function answer(i) {
        if (phase !== "ask" || ctx.signal.ended) return;
        phase = "reveal";
        const q = qs[qi], left = cfg.T - (ctx.now() - qStart) / 1000;
        const btns = ctx.root.querySelectorAll(".g-trivia-opt");
        btns.forEach((b, k) => { b.disabled = true; if (k === q.ans) b.classList.add("ok"); else if (k === i) b.classList.add("bad"); else b.classList.add("dim"); });
        const fb = $("[data-test=tv-fb]");
        if (i === q.ans) {
          const g = tvPoints(left, cfg.T); score += g; correct++; marks[qi] = "ok";
          fb.innerHTML = `<span class="dg-good">Correct · +${g}</span>`;
        } else {
          marks[qi] = "bad";
          fb.innerHTML = `<span class="dg-bad">${i < 0 ? "Time's up" : "Wrong"}</span> · <span class="dg-muted">Answer:</span> ${esc(q.opts[q.ans])}`;
        }
        $("[data-test=tv-score]").textContent = score + " pts";
        dots(); ctx.progress(score);
        ctx.timeout(next, cfg.reveal * 1000);
      }
      function tick() {
        if (phase !== "ask") return;
        const left = Math.max(0, cfg.T - (ctx.now() - qStart) / 1000);
        barI.style.transform = `scaleX(${left / cfg.T})`;
        bar.classList.toggle("low", left < 3);
        ctx.setStatus(`Q${qi + 1}/${qs.length} · ${left.toFixed(1)}s`);
        if (left <= 0) answer(-1);
      }
      function finish() {
        phase = "done";
        ctx.setStatus(`Done · ${score} pts`);
        ctx.end({ score, detail: `<p class="dg-note">${correct} of ${qs.length} correct · ${score} points (speed bonus included).</p>` });
      }
      ctx.interval(tick, 50);
      ctx.onKey((e) => { const k = "1234".indexOf(e.key); if (k >= 0) answer(k); });
      ctx.test = {
        state: () => ({ qi, phase, score, correct, ans: qi >= 0 && qi < qs.length ? qs[qi].ans : -1, n: qs.length, ids: qs.map((q) => q.id) }),
        answerCorrect() { if (phase !== "ask") return false; ctx.root.querySelectorAll(".g-trivia-opt")[qs[qi].ans].click(); return true; },
        answerWrong() { if (phase !== "ask") return false; ctx.root.querySelectorAll(".g-trivia-opt")[(qs[qi].ans + 1) % 4].click(); return true; },
      };
      next();
    },
    bot(seed, skill, rng, mode) {
      const cfg = tvCfg(mode), qs = triviaSet(seed, mode);
      let t = 0, score = 0;
      const tl = [[0, 0]];
      for (const q of qs) {
        const know = clamp([0, 0.45, 0.25, 0.1][q.d] + [0, 0.5, 0.6, 0.62][q.d] * skill, 0.02, 0.98);
        let ans, ok;
        if (rng() < know) { ok = true; ans = cfg.T * (0.62 - 0.45 * skill) * (0.55 + 0.9 * rng()); }
        else if (rng() < 0.85) { ok = rng() < 0.25; ans = cfg.T * (0.7 - 0.3 * skill + 0.3 * rng()); }
        else { ok = false; ans = cfg.T; }
        ans = clamp(ans, 0.9, cfg.T);
        t += ans;
        if (ok) score += tvPoints(cfg.T - ans, cfg.T);
        tl.push([Math.round(t * 100) / 100, score]);
        t += cfg.reveal;
      }
      return { score, timeline: tl };
    },
  });
  /* =====================================================================
     2. WORD GROUPS
     ===================================================================== */
  /* [puzzle difficulty 1-3, group1 (easiest) ... group4 (trickiest)] each group "Name|W,W,W,W" */
  const WG_RAW = [
    [1, "Fruits|MANGO,PEACH,GRAPE,LEMON", "Chess pieces|KNIGHT,BISHOP,ROOK,PAWN", "Planets|VENUS,SATURN,NEPTUNE,MERCURY", "___ball|FOOT,BASKET,SNOW,EYE"],
    [1, "Colours|CRIMSON,TEAL,AMBER,INDIGO", "Dog breeds|BEAGLE,POODLE,BOXER,HUSKY", "Instruments|CELLO,OBOE,TUBA,HARP", "___fly|BUTTER,DRAGON,FIRE,HOUSE"],
    [1, "Capital cities|OSLO,LIMA,CAIRO,ROME", "Card games|POKER,BRIDGE,SNAP,RUMMY", "Kitchen utensils|WHISK,LADLE,SPATULA,TONGS", "___storm|BRAIN,THUNDER,SAND,SNOW"],
    [1, "Weather|SLEET,HAIL,FOG,DRIZZLE", "Shapes|CIRCLE,SQUARE,TRIANGLE,OVAL", "Metals|COPPER,ZINC,TIN,IRON", "Things with keys|PIANO,LOCK,KEYBOARD,MAP"],
    [2, "Birds|EAGLE,ROBIN,HERON,FALCON", "Trees|OAK,MAPLE,BIRCH,WILLOW", "Units of length|METRE,INCH,MILE,YARD", "Things you hatch|EGG,PLAN,PLOT,SCHEME"],
    [1, "Vegetables|PARSNIP,LEEK,TURNIP,CELERY", "Dances|TANGO,WALTZ,SALSA,POLKA", "Greek letters|ALPHA,DELTA,SIGMA,OMEGA", "___cake|PAN,CUP,CHEESE,SPONGE"],
    [1, "Sea creatures|OCTOPUS,CRAB,SQUID,JELLYFISH", "Board games|CHESS,CHECKERS,GO,BACKGAMMON", "Fabrics|SILK,DENIM,LINEN,VELVET", "___light|SPOT,MOON,FLASH,HEAD"],
    [2, "Currencies|EURO,YEN,RUPEE,PESO", "Continents|ASIA,EUROPE,AFRICA,OCEANIA", "Gemstones|RUBY,OPAL,EMERALD,SAPPHIRE", "Things with scales|FISH,PIANO,MAP,SNAKE"],
    [3, "Racket sports|SQUASH,BADMINTON,PADEL,RACQUETBALL", "Parts of a flower|PETAL,STEM,SEPAL,STAMEN", "Pasta|PENNE,FUSILLI,LINGUINE,RAVIOLI", "Hidden numbers|OFTEN,BONE,WEIGHT,CANINE"],
    [2, "Breakfast foods|TOAST,CEREAL,PORRIDGE,OMELETTE", "Horse gaits|TROT,CANTER,GALLOP,AMBLE", "Painters|MONET,DALI,GOYA,KAHLO", "Palindromes|LEVEL,RADAR,KAYAK,CIVIC"],
    [2, "Clothing|SCARF,JACKET,GLOVE,SOCK", "Spices|CUMIN,NUTMEG,PAPRIKA,SAFFRON", "Car parts|GEARBOX,BUMPER,CLUTCH,EXHAUST", "___ship|FRIEND,HARD,LEADER,CHAMPION"],
    [2, "Insects|BEETLE,WASP,ANT,MOTH", "Rivers|NILE,AMAZON,DANUBE,THAMES", "Coffee drinks|LATTE,MOCHA,ESPRESSO,CAPPUCCINO", "You can draw them|CURTAINS,BATH,SWORD,CONCLUSION"],
    [2, "Cheeses|BRIE,FETA,GOUDA,CHEDDAR", "Boats|CANOE,YACHT,FERRY,BARGE", "Mountains and volcanoes|ETNA,FUJI,EVEREST,ELBRUS", "___print|FOOT,FINGER,BLUE,NEWS"],
    [2, "Salad vegetables|LETTUCE,CUCUMBER,TOMATO,RADISH", "Martial arts|JUDO,KARATE,AIKIDO,KENDO", "Keyboard keys|SHIFT,ENTER,TAB,SPACE", "You can break them|RECORD,NEWS,ICE,PROMISE"],
    [3, "Snakes|COBRA,PYTHON,VIPER,MAMBA", "Hats|BERET,FEDORA,BOWLER,BEANIE", "Emotions|JOY,ANGER,ENVY,GRIEF", "Hidden body parts|SPEAR,CHINA,WHIPS,LEGEND"],
    [2, "Nuts|ALMOND,CASHEW,PECAN,WALNUT", "Tools|HAMMER,CHISEL,WRENCH,PLIERS", "Cloud types|CIRRUS,CUMULUS,STRATUS,NIMBUS", "___house|LIGHT,GREEN,WARE,TREE"],
    [2, "Breads|BAGEL,BAGUETTE,CIABATTA,PITTA", "Olympic sports|ROWING,FENCING,ARCHERY,DIVING", "Composers|BACH,CHOPIN,HANDEL,VERDI", "___bow|RAIN,CROSS,LONG,OX"],
    [2, "Farm animals|GOAT,SHEEP,DONKEY,HEN", "Shades of blue|NAVY,AZURE,CYAN,TEAL", "Noble gases|NEON,ARGON,HELIUM,XENON", "Things with shells|TURTLE,SNAIL,OYSTER,EGG"],
    [2, "Soups|BORSCHT,GAZPACHO,MINESTRONE,CHOWDER", "Sewing kit|NEEDLE,THREAD,THIMBLE,BOBBIN", "Scientists|NEWTON,DARWIN,CURIE,TESLA", "___ring|EAR,BOXING,KEY,WEDDING"],
    [3, "Currencies|FRANC,KRONA,DINAR,RAND", "Chess terms|CHECK,MATE,CASTLE,GAMBIT", "Constellations|ORION,CYGNUS,LYRA,DRACO", "Add S to the front|NOW,TAR,PORT,WORD"],
    [1, "Tableware|PLATE,SPOON,BOWL,SAUCER", "Garden tools|RAKE,HOE,TROWEL,SHEARS", "Teas|OOLONG,MATCHA,CHAI,ROOIBOS", "___fish|SWORD,STAR,CAT,JELLY"],
    [3, "Units of time|DECADE,CENTURY,FORTNIGHT,MINUTE", "Whales|ORCA,BELUGA,NARWHAL,HUMPBACK", "Parts of a castle|MOAT,TURRET,DUNGEON,DRAWBRIDGE", "Starts with a vehicle|VANILLA,BUSY,TRAMPOLINE,CARPET"],
    [1, "Pizza toppings|PEPPERONI,MUSHROOM,OLIVE,ANCHOVY", "Swimming strokes|CRAWL,BUTTERFLY,BACKSTROKE,BREASTSTROKE", "Punctuation|COMMA,COLON,HYPHEN,APOSTROPHE", "Sun___|FLOWER,DIAL,SET,BURN"],
    [2, "Jobs|PILOT,FARMER,BAKER,PLUMBER", "Citrus fruits|LIME,ORANGE,GRAPEFRUIT,TANGERINE", "Poetry forms|HAIKU,SONNET,LIMERICK,ODE", "Things with needles|PINE,CACTUS,COMPASS,SYRINGE"],
    [3, "African countries|KENYA,GHANA,MALI,CHAD", "Rodents|HAMSTER,BEAVER,SQUIRREL,GERBIL", "Winter sports|SKIING,CURLING,LUGE,BIATHLON", "Hidden animals|DOGMA,PIRATE,BATCH,CATERING"],
    [2, "Computer parts|MOUSE,MONITOR,KEYBOARD,PRINTER", "Desserts|TIRAMISU,SORBET,TRIFLE,PAVLOVA", "Knots|REEF,BOWLINE,HITCH,SHEEPSHANK", "___port|PASS,AIR,SEA,SPACE"],
    [2, "Sauces|PESTO,SALSA,KETCHUP,MAYONNAISE", "3D shapes|CUBE,SPHERE,CONE,PYRAMID", "Noble titles|DUKE,BARON,EARL,MARQUESS", "Honey___|MOON,COMB,BEE,SUCKLE"],
    [2, "Seas|BALTIC,CARIBBEAN,CASPIAN,ADRIATIC", "Playground|SWING,ROUNDABOUT,SEESAW,SANDPIT", "Birds of prey|HAWK,KITE,OSPREY,BUZZARD", "Snow___|FLAKE,BOARD,MAN,DRIFT"],
    [2, "Fish|SALMON,TROUT,COD,HADDOCK", "Parts of the eye|IRIS,PUPIL,RETINA,CORNEA", "Rocks|GRANITE,BASALT,MARBLE,SLATE", "___bell|BLUE,DOOR,DUMB,COW"],
    [2, "Organs|HEART,LIVER,KIDNEY,LUNG", "Italian cities|MILAN,TURIN,NAPLES,VENICE", "Sports equipment|BAT,RACKET,CLUB,CUE", "Things you crack|CODE,JOKE,SAFE,SMILE"],
    [2, "Deserts|GOBI,SAHARA,KALAHARI,ATACAMA", "Pastry|FILO,PUFF,CHOUX,SHORTCRUST", "Theatre words|STAGE,CURTAIN,ENCORE,MATINEE", "Silent K|KNEE,KNOT,KNIFE,KNOCK"],
    [1, "Royalty|KING,QUEEN,PRINCE,PRINCESS", "Herbs|BASIL,MINT,THYME,SAGE", "Stationery|STAPLER,ERASER,SHARPENER,PENCIL", "Sound like numbers|WON,ATE,FOR,TOO"],
  ];
  const WG = WG_RAW.map((p) => ({ d: p[0], groups: p.slice(1).map((g, lv) => { const [name, w] = g.split("|"); return { name, words: w.split(","), lv }; }) }));
  const WG_PTS = [200, 250, 300, 350];
  const WG_COL = ["#E9C63A", "#5CC97B", "#5BA8F0", "#B384F0"];
  const wgCfg = (mode) => (mode === "mix" ? { T: 45 } : { T: 180 });
  function wgPuzzle(seed, mode) {
    const rng = U.rng(seed + ":groups:" + mode);
    const pi = Math.floor(rng() * WG.length), p = WG[pi];
    const tiles = U.shuffle(rng, p.groups.flatMap((g) => g.words.map((w) => ({ w, g: g.lv }))));
    return { pi, d: p.d, groups: p.groups, tiles };
  }
  const wgBonus = (left, T) => Math.round(300 * clamp(left / T, 0, 1));
  const wgScore = (found, mistakes, allLeft, T) =>
    Math.max(0, found.reduce((s, lv) => s + WG_PTS[lv], 0) + (found.length === 4 ? wgBonus(allLeft, T) : 0) - 50 * mistakes);

  DG.css("groups", `
    .g-groups{display:grid;gap:10px}
    .g-groups-top{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
    .g-groups-life{display:flex;gap:6px;align-items:center}
    .g-groups-life i{width:12px;height:12px;border-radius:50%;background:var(--gold);display:inline-block}
    .g-groups-life i.x{background:var(--panel-3)}
    .g-groups-solved{display:grid;gap:8px}
    .g-groups-band{border-radius:var(--r-md);padding:8px 10px;text-align:center;color:#141414}
    .g-groups-band b{display:block;font-family:var(--f-display);text-transform:uppercase;letter-spacing:.04em;font-size:17px;line-height:1.1}
    .g-groups-band span{font-weight:600;font-size:13px;letter-spacing:.03em}
    .g-groups-band.miss{opacity:.6;outline:2px dashed rgba(255,255,255,.4);outline-offset:-4px}
    .g-groups-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;touch-action:manipulation}
    .g-groups-tile{min-height:58px;padding:4px 3px;border-radius:var(--r-md);background:var(--panel-2);border:1px solid var(--line);
      font-weight:700;letter-spacing:.02em;font-size:15px;line-height:1.1;text-transform:uppercase;white-space:nowrap;overflow:hidden;user-select:none}
    @media (min-width:600px){.g-groups-tile{min-height:68px;font-size:17px}}
    .g-groups-tile:hover:not(:disabled){background:var(--panel-3)}
    .g-groups-tile[aria-pressed="true"],.g-groups-tile[aria-pressed="true"]:hover:not(:disabled){background:var(--gold);border-color:var(--gold);color:var(--on-gold)}
    .g-groups-tile.shake{animation:g-groups-shake .35s}
    @keyframes g-groups-shake{25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
    .g-groups-ctl{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
    .g-groups-msg{min-height:22px;text-align:center;font-weight:700}
  `);

  DG.registerGame({
    id: "groups", name: "Word Groups", category: "word", kind: "race",
    formats: ["1v1", "2v2", "ffa", "tournament", "mix"],
    skill: 8, luck: 2, cashEligible: true, duration: "3 min", pack: "social",
    blurb: "Sixteen words hide four groups of four. Find them before the clock or your mistakes run out.",
    rules: [
      "Select four words you think share a link, then press Submit.",
      "Groups are worth 200, 250, 300 and 350 from easiest (yellow) to trickiest (purple).",
      "Four wrong guesses end the game. Each wrong guess costs 50 points.",
      "\"One away\" means three of your four words belong together.",
      "Find all four groups for a time bonus of up to 300. You have 3 minutes (45 s in Duel Mix).",
    ],
    scoreLabel: "pts",
    play(ctx) {
      const cfg = wgCfg(ctx.mode), P = wgPuzzle(ctx.seed, ctx.mode);
      let tiles = P.tiles.slice(), sel = [], found = [], mistakes = 0, over = false;
      const guesses = new Set();
      ctx.root.innerHTML = `<div class="g-groups" data-test="groups">
        <div class="g-groups-top"><span class="dg-note" style="margin:0">Find four groups of four.</span>
          <span class="g-groups-life" data-test="wg-life"><span class="dg-eyebrow">Mistakes left</span></span></div>
        <div class="g-groups-solved"></div>
        <div class="g-groups-grid" data-test="wg-grid"></div>
        <div class="g-groups-msg" data-test="wg-msg" aria-live="polite"></div>
        <div class="g-groups-ctl">
          <button class="dg-btn" data-test="wg-shuffle">Shuffle</button>
          <button class="dg-btn" data-test="wg-clear">Deselect</button>
          <button class="dg-btn primary" data-test="wg-submit">Submit</button></div></div>`;
      const $ = (s) => ctx.root.querySelector(s);
      const cur = () => wgScore(found, mistakes, cfg.T - ctx.now() / 1000, cfg.T);
      const band = (g, miss) => `<div class="g-groups-band${miss ? " miss" : ""}" style="background:${WG_COL[g.lv]}" data-test="wg-band"><b>${esc(g.name)}</b><span>${g.words.join(", ")}</span></div>`;
      function render() {
        $(".g-groups-solved").innerHTML = found.map((lv) => band(P.groups[lv])).join("");
        const grid = $("[data-test=wg-grid]");
        grid.innerHTML = tiles.map((t) => `<button class="g-groups-tile" data-test="wg-tile" data-w="${t.w}" aria-pressed="${sel.includes(t.w)}">${t.w}</button>`).join("");
        grid.querySelectorAll(".g-groups-tile").forEach((b) => b.addEventListener("click", () => toggle(b.dataset.w)));
        fit();
        $("[data-test=wg-life]").innerHTML = `<span class="dg-eyebrow">Mistakes left</span>` + [0, 1, 2, 3].map((i) => `<i class="${i < 4 - mistakes ? "" : "x"}"></i>`).join("");
        syncBtns();
      }
      function fit() { // shrink long words until they fit their tile (no mid-word breaks)
        ctx.root.querySelectorAll(".g-groups-tile").forEach((b) => {
          b.style.fontSize = ""; b.style.letterSpacing = "";
          let fs = parseFloat(getComputedStyle(b).fontSize), n = 0;
          while (b.scrollWidth > b.clientWidth && fs > 9 && n++ < 12) { fs -= 1; b.style.fontSize = fs + "px"; b.style.letterSpacing = "0"; }
        });
      }
      let ro = null;
      if (window.ResizeObserver) { ro = new ResizeObserver(() => { if (ctx.signal.ended) { ro.disconnect(); return; } fit(); }); ro.observe(ctx.root); }
      function syncBtns() {
        $("[data-test=wg-submit]").disabled = over || sel.length !== 4;
        $("[data-test=wg-clear]").disabled = over || !sel.length;
        $("[data-test=wg-shuffle]").disabled = over;
      }
      function toggle(w) {
        if (over) return;
        if (sel.includes(w)) sel = sel.filter((x) => x !== w);
        else if (sel.length < 4) sel.push(w);
        ctx.root.querySelectorAll(".g-groups-tile").forEach((b) => b.setAttribute("aria-pressed", sel.includes(b.dataset.w)));
        $("[data-test=wg-msg]").textContent = "";
        syncBtns();
      }
      const msg = (h) => { $("[data-test=wg-msg]").innerHTML = h; };
      function submit() {
        if (over || sel.length !== 4) return;
        const key = sel.slice().sort().join("|");
        if (guesses.has(key)) return msg(`<span class="dg-muted">You already tried that.</span>`);
        guesses.add(key);
        const lvs = sel.map((w) => tiles.find((t) => t.w === w).g);
        const counts = {}; lvs.forEach((l) => (counts[l] = (counts[l] || 0) + 1));
        const best = Math.max(...Object.values(counts));
        if (best === 4) {
          const lv = lvs[0]; found.push(lv);
          tiles = tiles.filter((t) => t.g !== lv); sel = [];
          msg(`<span class="dg-good">${esc(P.groups[lv].name)} · +${WG_PTS[lv]}</span>`);
          render(); ctx.progress(cur());
          if (found.length === 4) finish("all");
        } else {
          mistakes++;
          ctx.root.querySelectorAll('.g-groups-tile[aria-pressed="true"]').forEach((b) => { b.classList.remove("shake"); void b.offsetWidth; b.classList.add("shake"); });
          msg(best === 3 ? `<span class="dg-gold">One away</span> · −50` : `<span class="dg-bad">Not a group</span> · −50`);
          $("[data-test=wg-life]").innerHTML = `<span class="dg-eyebrow">Mistakes left</span>` + [0, 1, 2, 3].map((i) => `<i class="${i < 4 - mistakes ? "" : "x"}"></i>`).join("");
          ctx.progress(cur());
          if (mistakes >= 4) finish("mistakes");
        }
      }
      function finish(why) {
        if (over) return;
        over = true;
        if (ro) ro.disconnect();
        const left = cfg.T - ctx.now() / 1000;
        const score = wgScore(found, mistakes, left, cfg.T);
        const missing = P.groups.filter((g) => !found.includes(g.lv));
        $(".g-groups-solved").innerHTML = found.map((lv) => band(P.groups[lv])).join("") + missing.map((g) => band(g, true)).join("");
        $("[data-test=wg-grid]").innerHTML = "";
        msg(why === "all" ? `<span class="dg-good">All four groups found</span>` : why === "time" ? `<span class="dg-bad">Time's up</span>` : `<span class="dg-bad">Out of guesses</span>`);
        syncBtns(); ctx.progress(score);
        ctx.setStatus(`Done · ${score} pts`);
        const bonus = found.length === 4 ? wgBonus(left, cfg.T) : 0;
        ctx.timeout(() => ctx.end({ score, detail: `<p class="dg-note">${found.length}/4 groups · ${mistakes} mistake${mistakes === 1 ? "" : "s"}${bonus ? " · time bonus +" + bonus : ""} · ${score} points.</p>` }), 1400);
      }
      $("[data-test=wg-submit]").addEventListener("click", submit);
      $("[data-test=wg-clear]").addEventListener("click", () => { sel = []; render(); msg(""); });
      $("[data-test=wg-shuffle]").addEventListener("click", () => { tiles = U.shuffle(Math.random, tiles); render(); });
      ctx.onKey((e) => { if (e.key === "Enter") submit(); });
      ctx.interval(() => {
        if (over) return;
        const left = cfg.T - ctx.now() / 1000;
        ctx.setStatus(`${clock(left)} · ${found.length}/4 groups`);
        if (left <= 0) finish("time");
      }, 200);
      ctx.test = {
        state: () => ({ found: found.slice(), mistakes, sel: sel.slice(), over, left: tiles.map((t) => t.w), puzzle: P.pi }),
        solution: () => P.groups.map((g) => ({ name: g.name, lv: g.lv, words: g.words.slice() })),
        submitGroup(i) { if (over || found.includes(i)) return false; sel = P.groups[i].words.slice(); submit(); return true; },
      };
      render();
      ctx.setStatus(`${clock(cfg.T)} · 0/4 groups`);
    },
    bot(seed, skill, rng, mode) {
      /* Simulates solving the actual seeded puzzle: groups are attempted easiest-first; the chance to spot a group
         falls with its level and the puzzle's difficulty; weak players take longer and make more wrong guesses.
         Almost everyone finds the yellow group; purple separates strong players. */
      const cfg = wgCfg(mode), P = wgPuzzle(seed, mode);
      const hard = P.d; // 1..3
      let t = 0, mistakes = 0;
      const found = [], tl = [[0, 0]];
      const pace = mode === "mix" ? 0.62 : 1;
      for (let lv = 0; lv < 4; lv++) {
        if (found.length === 3) { t += 2 + 3 * rng(); if (t > cfg.T) break; found.push(lv); tl.push([+t.toFixed(2), wgScore(found, mistakes, cfg.T - t, cfg.T)]); break; }
        const pSee = clamp([0.8, 0.42, 0.24, 0.14][lv] + [0.2, 0.36, 0.44, 0.5][lv] * skill + 0.2 * skill * skill - 0.06 * (hard - 1), 0.05, 0.99);
        const pWrong = clamp((0.45 - 0.35 * skill) * (lv === 0 ? 0.5 : 1), 0.03, 0.9);
        let solved = false;
        for (let tries = 0; tries < 3 && !solved; tries++) {
          t += pace * (8 + 8 * lv + 4 * hard) * (1.8 - 1.3 * skill) * (0.6 + 0.8 * rng());
          if (t > cfg.T) break;
          if (rng() < pSee) solved = true;
          else if (rng() < pWrong) {
            mistakes++;
            tl.push([+t.toFixed(2), wgScore(found, mistakes, cfg.T - t, cfg.T)]);
            if (mistakes >= 4) break;
          }
        }
        if (t > cfg.T || mistakes >= 4) break;
        if (solved) { found.push(lv); tl.push([+t.toFixed(2), wgScore(found, mistakes, cfg.T - t, cfg.T)]); }
        else break; // stuck on this level: stops finding further groups (keeps what it has)
      }
      const end = Math.min(t, cfg.T);
      const score = wgScore(found, mistakes, cfg.T - end, cfg.T);
      const last = tl[tl.length - 1];
      if (last[1] !== score || last[0] < end) tl.push([+Math.max(end, last[0]).toFixed(2), score]);
      return { score, timeline: tl };
    },
  });

  /* =====================================================================
     3. DURAK (podkidnoy, 2 players, 36 cards)
     ===================================================================== */
  const SUITS = ["♠", "♥", "♦", "♣"];
  const SUIT_NAMES = ["spades", "hearts", "diamonds", "clubs"];
  const RED = [false, true, true, false];
  const RANKS = { 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A" };
  const cRank = (c) => 6 + (c % 9), cSuit = (c) => Math.floor(c / 9);
  const cName = (c) => RANKS[cRank(c)] + SUITS[cSuit(c)];
  const cardHTML = (c, cls) => { const s = cSuit(c); return `<span class="g-durak-card ${RED[s] ? "red" : "blk"} ${cls || ""}" data-card="${c}"><span class="ix"><b>${RANKS[cRank(c)]}</b><i>${SUITS[s]}</i></span><span class="pip">${SUITS[s]}</span></span>`; };
  const backHTML = (cls) => `<span class="g-durak-card back ${cls || ""}"></span>`;

  const DK = (function () {
    const beats = (a, d, tr) => (cSuit(d) === cSuit(a) && cRank(d) > cRank(a)) || (cSuit(d) === tr && cSuit(a) !== tr);
    function create(seed) {
      const rng = U.rng(seed + ":durak");
      const deck = U.shuffle(rng, Array.from({ length: 36 }, (_, i) => i));
      const hands = [[], []];
      for (let i = 0; i < 6; i++) { hands[0].push(deck.pop()); hands[1].push(deck.pop()); }
      const trumpCard = deck[0], trump = cSuit(trumpCard);
      const lowT = (h) => { const t = h.filter((c) => cSuit(c) === trump).map(cRank); return t.length ? Math.min(...t) : 99; };
      const l0 = lowT(hands[0]), l1 = lowT(hands[1]);
      const att = l0 < l1 ? 0 : l1 < l0 ? 1 : rng() < 0.5 ? 0 : 1;
      return { deck, hands, table: [], discard: [], trump, trumpCard, att, phase: "play", limit: Math.min(6, hands[1 - att].length),
        winner: null, bout: 1, known: [[], []], firstLow: Math.min(l0, l1) };
    }
    const clone = (s) => ({ deck: s.deck.slice(), hands: [s.hands[0].slice(), s.hands[1].slice()], table: s.table.map((p) => ({ a: p.a, d: p.d })),
      discard: s.discard.slice(), trump: s.trump, trumpCard: s.trumpCard, att: s.att, phase: s.phase, limit: s.limit, winner: s.winner,
      bout: s.bout, known: [s.known[0].slice(), s.known[1].slice()], firstLow: s.firstLow });
    function toMove(s) {
      if (s.phase === "over") return -1;
      if (s.phase === "taking") return s.att;
      return s.table.some((p) => p.d == null) ? 1 - s.att : s.att;
    }
    const ranksOn = (s) => { const r = new Set(); s.table.forEach((p) => { r.add(cRank(p.a)); if (p.d != null) r.add(cRank(p.d)); }); return r; };
    function legal(s) {
      const p = toMove(s); if (p < 0) return [];
      const h = s.hands[p], mv = [];
      const throws = () => { if (s.table.length < s.limit) { const rs = ranksOn(s); h.forEach((c) => { if (rs.has(cRank(c))) mv.push({ t: "throw", c }); }); } };
      if (s.phase === "taking") { throws(); mv.push({ t: "done" }); return mv; }
      const open = s.table.findIndex((x) => x.d == null);
      if (open >= 0) { const a = s.table[open].a; h.forEach((c) => { if (beats(a, c, s.trump)) mv.push({ t: "beat", c, i: open }); }); mv.push({ t: "take" }); return mv; }
      if (!s.table.length) { h.forEach((c) => mv.push({ t: "attack", c })); return mv; }
      throws(); mv.push({ t: "bito" }); return mv;
    }
    const same = (a, b) => a.t === b.t && (a.c == null || a.c === b.c);
    const isLegal = (s, m) => legal(s).some((x) => same(x, m));
    function endBout(s, took) {
      const def = 1 - s.att;
      for (const p of [s.att, def]) while (s.hands[p].length < 6 && s.deck.length) {
        const c = s.deck.pop(); s.hands[p].push(c); if (c === s.trumpCard) s.known[p].push(c);
      }
      s.phase = "play";
      if (!took) s.att = def;
      s.bout++;
      if (!s.deck.length) {
        const e0 = !s.hands[0].length, e1 = !s.hands[1].length;
        if (e0 || e1) { s.phase = "over"; s.winner = e0 && e1 ? -1 : e0 ? 0 : 1; }
      }
      s.limit = Math.min(6, s.hands[1 - s.att].length);
    }
    function apply(s, m) {
      const p = toMove(s);
      if (m.c != null) {
        const h = s.hands[p], k = h.indexOf(m.c);
        if (k < 0) throw new Error("durak: card not in hand");
        h.splice(k, 1);
        const kk = s.known[p].indexOf(m.c); if (kk >= 0) s.known[p].splice(kk, 1);
      }
      if (m.t === "attack" || m.t === "throw") s.table.push({ a: m.c, d: null });
      else if (m.t === "beat") s.table[m.i].d = m.c;
      else if (m.t === "take") s.phase = "taking";
      else if (m.t === "done") {
        const def = 1 - s.att, cards = [];
        s.table.forEach((x) => { cards.push(x.a); if (x.d != null) cards.push(x.d); });
        s.hands[def].push(...cards); s.known[def].push(...cards); s.table = []; endBout(s, true);
      } else if (m.t === "bito") { s.table.forEach((x) => s.discard.push(x.a, x.d)); s.table = []; endBout(s, false); }
      return s;
    }
    const total = (s) => s.deck.length + s.hands[0].length + s.hands[1].length + s.discard.length + s.table.reduce((n, x) => n + (x.d == null ? 1 : 2), 0);

    /* ---- AI ---- */
    const val = (s, c) => cRank(c) + (cSuit(c) === s.trump ? 9 : 0);
    function order(s, mv) { return mv.slice().sort((a, b) => (a.c == null ? 99 : val(s, a.c)) - (b.c == null ? 99 : val(s, b.c))); }
    function searchBest(s, me, budget) {
      let nodes = 0, aborted = false;
      const ev = (x) => x.phase === "over" ? (x.winner === -1 ? 0 : x.winner === me ? 1000 : -1000) : (x.hands[1 - me].length - x.hands[me].length) * 10;
      function mm(x, depth, alpha, beta) {
        if (x.phase === "over" || depth === 0) return ev(x);
        if (++nodes > budget) { aborted = true; return ev(x); }
        const max = toMove(x) === me;
        let best = max ? -1e9 : 1e9;
        for (const m of order(x, legal(x))) {
          const v = mm(apply(clone(x), m), depth - 1, alpha, beta);
          if (max) { if (v > best) best = v; if (best > alpha) alpha = best; }
          else { if (v < best) best = v; if (best < beta) beta = best; }
          if (alpha >= beta || aborted) break;
        }
        return best;
      }
      let bestMove = null;
      for (let d = 2; d <= 48; d += 2) {
        const mv = order(s, legal(s)); let bv = -1e9, bm = null, alpha = -1e9;
        for (const m of mv) { const v = mm(apply(clone(s), m), d - 1, alpha, 1e9); if (aborted) break; if (v > bv) { bv = v; bm = m; } if (bv > alpha) alpha = bv; }
        if (aborted) break;
        bestMove = bm;
        if (Math.abs(bv) >= 1000) break;
      }
      return bestMove;
    }
    function choose(s, skill, rng) {
      const mv = legal(s), p = toMove(s);
      if (mv.length === 1) return mv[0];
      const h = s.hands[p], tr = s.trump, dl = s.deck.length;
      // Endgame: deck empty -> perfect information for a card-counter; search it.
      if (!dl && skill > 0.4 && rng() < 0.3 + skill * 0.75) { const r = searchBest(s, p, Math.round(1500 + 9000 * skill)); if (r) return r; }
      const noisy = rng() < (1 - skill) * 0.4;
      const seen = new Set(s.discard.concat(h));
      const topOfSuit = (c) => { for (let r = cRank(c) + 1; r <= 14; r++) if (!seen.has(cSuit(c) * 9 + r - 6)) return false; return true; };
      const cards = (t) => mv.filter((m) => m.t === t);
      const pick = (arr, sc) => { const o = arr.slice().sort((a, b) => sc(a) - sc(b)); return noisy ? o[Math.floor(rng() * Math.min(3, o.length))] : o[0]; };
      const at = cards("attack");
      if (at.length) {
        return pick(at, (m) => {
          const c = m.c; let v = val(s, c);
          v -= 1.8 * (h.filter((x) => cRank(x) === cRank(c)).length - 1);
          if (dl > 0 && cSuit(c) === tr) v += 6;
          if (skill > 0.4 && dl <= 6 && cSuit(c) !== tr && topOfSuit(c)) v -= 4 * skill;
          return v;
        });
      }
      const bt = cards("beat");
      if (mv.some((m) => m.t === "take")) {
        if (!bt.length) return { t: "take" };
        const sorted = order(s, bt), b = noisy ? sorted[Math.floor(rng() * sorted.length)] : sorted[0];
        const a = s.table.find((x) => x.d == null).a;
        if (dl >= 10 && cSuit(b.c) === tr && cSuit(a) !== tr) {
          const pricey = cRank(b.c) >= 12 || (s.table.length === 1 && cRank(a) <= 8 && cRank(b.c) >= 10);
          if (pricey && rng() < 0.15 + 0.75 * skill) return { t: "take" };
        }
        if (!noisy && rng() < (1 - skill) * 0.08) return { t: "take" };
        return b;
      }
      // attacker: throw in or finish (bito / done)
      const th = order(s, cards("throw"));
      const fin = mv.find((m) => m.t === "bito" || m.t === "done");
      if (!th.length) return fin;
      if (noisy) return rng() < 0.5 ? th[0] : fin;
      const c = th[0].c;
      if (!dl) return th[0];
      const taking = s.phase === "taking";
      const cap = taking ? (dl > 8 ? 10 : 11) : (dl > 12 ? 10 : 12);
      if (cSuit(c) !== tr && cRank(c) <= cap) return th[0];
      if (cSuit(c) === tr && dl <= 2 && !taking) return th[0];
      return fin;
    }
    function simulate(n, seed0, skills) {
      const res = { games: 0, wins: [0, 0], draws: 0, maxMoves: 0, violations: [] };
      for (let g = 0; g < n; g++) {
        const s = create(seed0 + ":sim:" + g), rng = U.rng("durak-sim-" + seed0 + ":" + g);
        const sk = skills || [0.1 + 0.85 * rng(), 0.1 + 0.85 * rng()];
        let moves = 0;
        while (s.phase !== "over" && moves < 3000) {
          const p = toMove(s), m = choose(s, sk[p], rng);
          if (!isLegal(s, m)) { res.violations.push("illegal " + JSON.stringify(m)); break; }
          apply(s, m); moves++;
          if (total(s) !== 36) { res.violations.push("conservation " + total(s)); break; }
          const all = s.deck.concat(s.hands[0], s.hands[1], s.discard, s.table.flatMap((x) => (x.d == null ? [x.a] : [x.a, x.d])));
          if (new Set(all).size !== 36) { res.violations.push("duplicate card"); break; }
        }
        if (s.phase !== "over") res.violations.push("no termination game " + g);
        res.games++; res.maxMoves = Math.max(res.maxMoves, moves);
        if (s.winner === -1) res.draws++; else if (s.winner != null) res.wins[s.winner]++;
      }
      return res;
    }
    return { create, clone, toMove, legal, isLegal, apply, total, choose, simulate, beats };
  })();

  DG.css("durak", `
    .g-durak{--cw:44px;display:grid;gap:10px;user-select:none}
    @media (min-width:560px){.g-durak{--cw:58px}}
    .g-durak-card{position:relative;display:block;width:var(--cw);height:calc(var(--cw)*1.42);border-radius:6px;background:#F6F2E8;
      border:1px solid #C9C2AE;box-shadow:0 2px 6px rgba(0,0,0,.45);color:#17182A;flex:none;overflow:hidden}
    .g-durak-card.red{color:#C41E3A}
    .g-durak-card .ix{position:absolute;left:3px;top:2px;display:flex;flex-direction:column;align-items:center;line-height:.95}
    .g-durak-card .ix b{font-family:var(--f-body);font-weight:800;font-size:calc(var(--cw)*.3);letter-spacing:-.04em}
    .g-durak-card .ix i{font-style:normal;font-size:calc(var(--cw)*.26)}
    .g-durak-card .pip{position:absolute;right:4px;bottom:1px;font-size:calc(var(--cw)*.55);line-height:1}
    .g-durak-card.back{background:repeating-linear-gradient(45deg,#3B3F74 0 4px,#2B2E57 4px 8px);border:2px solid #F6F2E8}
    .g-durak-card.trumpc{box-shadow:0 0 0 2px var(--gold),0 2px 6px rgba(0,0,0,.45)}
    .g-durak-pl{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
    .g-durak-name{font-weight:700;display:flex;gap:8px;align-items:center}
    .g-durak-role{font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
    .g-durak-role.on{border-color:currentColor}
    .g-durak-fan{display:flex;justify-content:center;min-height:calc(var(--cw)*1.42 + 10px);padding-top:10px;touch-action:manipulation}
    .g-durak-fan .slot{position:relative;flex:0 1 calc(var(--cw) + 4px);min-width:0;padding:0;border:0;background:none;display:block;text-align:left}
    .g-durak-fan .slot:last-child{flex:0 0 auto}
    .g-durak-fan.small{--cw:30px;min-height:48px;padding-top:0}
    .g-durak-fan button.slot{cursor:pointer;transition:transform .12s}
    .g-durak-fan button.slot:disabled{cursor:default}
    .g-durak-fan button.slot.legal{transform:translateY(-9px)}
    .g-durak-fan button.slot.legal .g-durak-card{box-shadow:0 0 0 2px var(--gold),0 4px 10px rgba(0,0,0,.5)}
    .g-durak-fan.turn button.slot:not(.legal) .g-durak-card{filter:brightness(.55)}
    .g-durak-mid{display:grid;grid-template-columns:auto 1fr;gap:12px;align-items:center;background:var(--panel);border:1px solid var(--line);
      border-radius:var(--r-lg);padding:10px;min-height:calc(var(--cw)*2.3 + 20px)}
    .g-durak-deck{position:relative;width:calc(var(--cw)*1.6);height:calc(var(--cw)*1.42 + 24px)}
    .g-durak-deck .tc{position:absolute;left:0;top:0}
    .g-durak-deck .bk{position:absolute;left:calc(var(--cw)*.6);top:5px}
    .g-durak-deck .cnt{position:absolute;left:0;right:0;bottom:0;text-align:center;font-family:var(--f-mono);font-size:12px;color:var(--muted);white-space:nowrap}
    .g-durak-trump{font-size:12px;color:var(--muted);text-align:center;white-space:nowrap}
    .g-durak-trump b{font-size:18px;color:var(--fg)} .g-durak-trump b.red{color:#FF7A8E}
    .g-durak-table{display:flex;flex-wrap:wrap;gap:6px 10px;align-content:center;min-height:calc(var(--cw)*1.8)}
    .g-durak-pair{position:relative;width:calc(var(--cw) + 14px);height:calc(var(--cw)*1.42 + 16px)}
    .g-durak-pair .g-durak-card{position:absolute;left:0;top:0}
    .g-durak-pair .g-durak-card.def{left:14px;top:16px}
    .g-durak-pair .g-durak-card.open{box-shadow:0 0 0 2px var(--rival),0 2px 6px rgba(0,0,0,.45)}
    .g-durak-new{animation:g-durak-in .25s ease-out}
    @keyframes g-durak-in{from{transform:translateY(-14px) scale(1.08);opacity:.2}}
    .g-durak-empty{color:var(--muted);font-size:13px;align-self:center}
    .g-durak-msg{text-align:center;font-weight:700;min-height:24px}
    .g-durak-ctl{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;min-height:40px}
    .g-durak-log{font-size:12.5px;color:var(--muted);text-align:center;min-height:19px}
  `);

  function durakView(root, s, v) {
    /* v = {bottom, names:[n0,n1], reveal, legal:[moves]|null, msg, log, lastCard, buttons:[{t,label,primary}] , turnSide:'me'|'opp'} */
    const B = v.bottom, T = 1 - B, turn = DK.toMove(s);
    const role = (p) => s.phase === "over" ? "" : p === s.att ? (s.phase === "taking" ? "Attacking · rival takes" : "Attacking") : s.phase === "taking" ? "Taking" : "Defending";
    const col = (p) => (p === B ? "dg-gold" : "dg-rival");
    const legalCards = new Set((v.legal || []).filter((m) => m.c != null).map((m) => m.c));
    const sortH = (h) => h.slice().sort((a, b) => ((cSuit(a) === s.trump) - (cSuit(b) === s.trump)) || cSuit(a) - cSuit(b) || cRank(a) - cRank(b));
    const plRow = (p) => `<div class="g-durak-pl"><span class="g-durak-name ${col(p)}">${esc(v.names[p])} <span class="g-durak-role ${turn === p ? "on" : ""}">${role(p)}</span></span>
      <span class="dg-mono dg-muted" data-test="dk-count-${p === B ? "me" : "opp"}">${s.hands[p].length} card${s.hands[p].length === 1 ? "" : "s"}</span></div>`;
    const topHand = v.reveal ? sortH(s.hands[T]).map((c) => `<span class="slot">${cardHTML(c)}</span>`).join("") : s.hands[T].map(() => `<span class="slot">${backHTML()}</span>`).join("");
    const myTurn = !!v.legal;
    const botHand = sortH(s.hands[B]).map((c) => v.interactive
      ? `<button class="slot ${legalCards.has(c) ? "legal" : ""}" data-test="dk-card" data-c="${c}" ${legalCards.has(c) ? "" : "disabled"} aria-label="${RANKS[cRank(c)]} of ${SUIT_NAMES[cSuit(c)]}">${cardHTML(c, cSuit(c) === s.trump ? "" : "")}</button>`
      : `<span class="slot">${cardHTML(c)}</span>`).join("");
    const table = s.table.length ? s.table.map((x) => `<div class="g-durak-pair" data-test="dk-pair">${cardHTML(x.a, (x.d == null ? "open " : "") + (x.a === v.lastCard ? "g-durak-new" : ""))}${x.d != null ? cardHTML(x.d, "def " + (x.d === v.lastCard ? "g-durak-new" : "")) : ""}</div>`).join("")
      : `<span class="g-durak-empty">${s.phase === "over" ? "" : "Table empty"}</span>`;
    const deck = `<div class="g-durak-deck" data-test="dk-deck">${s.deck.length ? cardHTML(s.trumpCard, "tc trumpc") : ""}${s.deck.length > 1 ? backHTML("bk") : ""}
      <span class="cnt">${s.deck.length ? "Deck " + s.deck.length : "Deck empty"}</span></div>
      <div class="g-durak-trump" data-test="dk-trump">Trump <b class="${RED[s.trump] ? "red" : ""}">${SUITS[s.trump]}</b><br>Bito ${s.discard.length}</div>`;
    root.innerHTML = `<div class="g-durak" data-test="durak">
      ${plRow(T)}
      <div class="g-durak-fan small">${topHand}</div>
      <div class="g-durak-mid"><div style="display:grid;gap:4px;justify-items:center">${deck}</div><div class="g-durak-table" data-test="dk-table">${table}</div></div>
      <div class="g-durak-log">${v.log || ""}</div>
      <div class="g-durak-msg" data-test="dk-msg">${v.msg || ""}</div>
      <div class="g-durak-ctl">${(v.buttons || []).map((b) => `<button class="dg-btn ${b.primary ? "primary" : ""}" data-test="dk-${b.t}" data-t="${b.t}">${b.label}</button>`).join("")}</div>
      <div class="g-durak-fan ${myTurn && v.interactive ? "turn" : ""}" data-test="dk-hand">${botHand}</div>
      ${plRow(B)}</div>`;
  }
  const dkDescribe = (s, p, m, names, you) => {
    const S = (q, verb) => subj(names[q], you(q), verb);
    if (m.t === "attack") return `${S(p, "attacks")} with ${cName(m.c)}`;
    if (m.t === "throw") return `${S(p, "throws in")} ${cName(m.c)}`;
    if (m.t === "beat") return `${S(p, "beats")} ${cName(s.table[m.i].a)} with ${cName(m.c)}`;
    if (m.t === "take") return S(p, "takes");
    if (m.t === "done") return `${S(1 - p, "picks up")} the table`;
    return `Bito — cards discarded`;
  };

  function durakMatch(ctx, spect) {
    const s = DK.create(ctx.seed);
    const names = spect ? [ctx.players[0].name, ctx.players[1].name] : [ctx.me.name || "You", ctx.opponents[0].name];
    const skills = spect ? [ctx.players[0].skill, ctx.players[1].skill] : [null, ctx.opponents[0].skill];
    const aiRng = U.rng(ctx.seed + ":durak-ai");
    const you = (p) => !spect && p === 0;
    let log = `${subj(names[s.att], you(s.att), "leads")}${s.firstLow < 99 ? " (lowest trump)" : ""}.`, lastCard = null, auto = false, pending = false, moves = 0;
    const HUMAN = 0;
    function statusText() {
      if (s.phase === "over") return "Game over";
      const p = DK.toMove(s);
      return `Bout ${s.bout} · ${spect ? short(names[p]) : p === HUMAN ? "Your move" : "Rival's move"} · deck ${s.deck.length}`;
    }
    function humanPrompt(mv) {
      if (s.phase === "taking") return `${esc(names[1])} takes. Throw in more ${"matching"} cards or press Done.`;
      if (s.table.some((x) => x.d == null)) return mv.some((m) => m.t === "beat") ? "Defend: tap a highlighted card to beat, or Take." : "You can't beat it — press Take.";
      if (!s.table.length) return "Your attack: play any card.";
      return mv.some((m) => m.t === "throw") ? "All beaten. Throw in a matching rank, or press Bito." : "All beaten. Press Bito.";
    }
    function render() {
      if (ctx.signal.ended) return;
      const p = DK.toMove(s);
      const humanTurn = !spect && p === HUMAN && s.phase !== "over" && !auto;
      const mv = humanTurn ? DK.legal(s) : null;
      const buttons = [];
      if (humanTurn) {
        if (mv.some((m) => m.t === "take")) buttons.push({ t: "take", label: "Take" });
        if (mv.some((m) => m.t === "bito")) buttons.push({ t: "bito", label: "Bito · done", primary: true });
        if (mv.some((m) => m.t === "done")) buttons.push({ t: "done", label: "Done", primary: true });
      }
      const msg = s.phase === "over" ? overMsg() : spect ? `<span class="${p === 0 ? "dg-gold" : "dg-rival"}">${esc(names[p])}</span> to move`
        : humanTurn ? humanPrompt(mv) : `<span class="dg-rival">${esc(names[1])}</span> is thinking…`;
      durakView(ctx.root, s, { bottom: 0, names, reveal: spect || s.phase === "over", legal: mv, interactive: !spect, msg, log: esc(log), lastCard, buttons });
      ctx.setStatus(statusText());
      if (humanTurn) {
        ctx.root.querySelectorAll("button.slot").forEach((b) => b.addEventListener("click", () => {
          const c = +b.dataset.c, m = mv.find((x) => x.c === c); if (m) play(m);
        }));
        ctx.root.querySelectorAll(".g-durak-ctl [data-t]").forEach((b) => b.addEventListener("click", () => play({ t: b.dataset.t })));
      }
    }
    function overMsg() {
      if (s.winner === -1) return `<span class="dg-gold">Draw</span> — both hands emptied together`;
      if (spect) return `<span class="${s.winner === 0 ? "dg-gold" : "dg-rival"}">${esc(names[s.winner])} wins</span> · ${esc(names[1 - s.winner])} is the durak`;
      return s.winner === HUMAN ? `<span class="dg-good">You win</span> — ${esc(names[1])} is the durak` : `<span class="dg-bad">You are the durak</span>`;
    }
    function play(m) {
      if (ctx.signal.ended || s.phase === "over" || pending) return;
      const p = DK.toMove(s);
      if (!DK.isLegal(s, m)) return;
      const full = m.t === "beat" ? DK.legal(s).find((x) => x.t === "beat" && x.c === m.c) : m;
      log = dkDescribe(s, p, full, names, you);
      DK.apply(s, full); moves++;
      lastCard = full.c != null ? full.c : null;
      if (DK.total(s) !== 36) throw new Error("durak: card conservation broken");
      render();
      if (s.phase === "over") return finish();
      schedule();
    }
    function schedule() {
      if (ctx.signal.ended || s.phase === "over") return;
      const p = DK.toMove(s);
      const mv = DK.legal(s);
      if (spect || p !== HUMAN || auto) {
        pending = true;
        const fast = auto && !spect;
        ctx.timeout(() => {
          pending = false;
          const sk = p === HUMAN && !spect ? 0.75 : skills[p];
          play(DK.choose(s, sk, aiRng));
        }, fast ? 40 : spect ? 650 + 300 * aiRng() : 450 + 400 * aiRng());
      } else if (mv.length === 1 && (mv[0].t === "bito" || mv[0].t === "done")) {
        pending = true;
        ctx.timeout(() => { pending = false; play(mv[0]); }, 900);
      }
    }
    function finish() {
      const my = s.hands[0].length, op = s.hands[1].length;
      ctx.setStatus("Game over");
      ctx.timeout(() => {
        const pts = s.winner === -1 ? [0.5, 0.5] : s.winner === 0 ? [1, 0] : [0, 1];
        if (spect) return ctx.end({ winner: s.winner, scores: pts });
        const outcome = s.winner === -1 ? "draw" : s.winner === HUMAN ? "win" : "loss";
        ctx.end({ outcome, myScore: pts[0], oppScore: pts[1], detail: `<p class="dg-note">Cards left: you ${my} · ${esc(names[1])} ${op}. ${outcome === "win" ? "You shed your cards first." : outcome === "loss" ? "You were left holding the cards." : "Both hands emptied in the same bout."} ${s.bout - 1} bouts played.</p>` });
      }, spect ? 1800 : 1500);
    }
    ctx.test = {
      state: () => ({ phase: s.phase, toMove: DK.toMove(s), att: s.att, trump: s.trump, deck: s.deck.length, hands: [s.hands[0].length, s.hands[1].length],
        myHand: s.hands[0].slice(), table: s.table.map((x) => [x.a, x.d]), discard: s.discard.length, total: DK.total(s), winner: s.winner, bout: s.bout,
        legal: DK.toMove(s) === 0 ? DK.legal(s) : [] }),
      autoplay() { auto = true; if (!pending) { render(); schedule(); } return true; },
      simulate: (n, seed, skills) => DK.simulate(n, seed, skills),
    };
    render(); schedule();
  }

  DG.registerGame({
    id: "durak", name: "Durak", category: "cards", kind: "versus", formats: ["1v1", "tournament"],
    skill: 6, luck: 5, cashEligible: false, duration: "6 min", pack: "social",
    blurb: "The classic Russian throw-in card game. Shed your cards — the last one holding cards is the durak.",
    rules: [
      "36 cards (6 to Ace). The bottom card of the deck sets the trump suit. Lowest trump leads first.",
      "Attack with any card; you may throw in more cards of ranks already on the table (max 6, never more than the defender holds).",
      "Defend each card with a higher card of the same suit, or any trump. Or take the whole table.",
      "Everyone draws back to 6, attacker first. After a successful defence the defender attacks next.",
      "When the deck is empty, whoever still holds cards at the end is the durak and loses.",
    ],
    scoreLabel: "pts",
    play(ctx) { durakMatch(ctx, false); },
    spectate(ctx) { durakMatch(ctx, true); },
  });

  /* =====================================================================
     4. LIAR'S DICE (2 players, 5 dice each, 1s wild unless bidding on 1s)
     ===================================================================== */
  const LD = (function () {
    const binTail = (n, p, k) => { // P(X >= k), X ~ Bin(n,p)
      if (k <= 0) return 1; if (k > n) return 0;
      let s = 0; for (let i = k; i <= n; i++) { let c = 1; for (let j = 0; j < i; j++) c = c * (n - j) / (j + 1); s += c * Math.pow(p, i) * Math.pow(1 - p, n - i); }
      return s;
    };
    const countFace = (dice, f) => dice.filter((d) => d === f || (f !== 1 && d === 1)).length;
    // bid ordering: (q,f) -> rank. Bids on 1s count double: q ones ~ 2q of other faces.
    const bidRank = (b) => (b.f === 1 ? b.q * 2 * 10 + 1.5 : b.q * 10 + b.f);
    const higher = (b, prev) => !prev || bidRank(b) > bidRank(prev);
    function allBids(total, prev) {
      const out = [];
      for (let q = 1; q <= total; q++) for (let f = 1; f <= 6; f++) { const b = { q, f }; if (higher(b, prev)) out.push(b); }
      return out.sort((a, b) => bidRank(a) - bidRank(b));
    }
    function minQty(f, prev, total) { for (let q = 1; q <= total; q++) if (higher({ q, f }, prev)) return q; return null; }
    function probTrue(b, myDice, oppN) {
      const mine = countFace(myDice, b.f), p = b.f === 1 ? 1 / 6 : 1 / 3;
      return binTail(oppN, p, b.q - mine);
    }
    function choose(st, p, skill, rng) {
      const my = st.dice[p], oppN = st.dice[1 - p].length, total = my.length + oppN, prev = st.bid;
      const noise = (1 - skill) * 0.4;
      if (prev) {
        const pt = probTrue(prev, my, oppN);
        const thr = 0.5 - 0.1 * skill + (rng() - 0.5) * noise * 2 - (1 - skill) * 0.12;
        if (pt < thr || !allBids(total, prev).length) return { t: "call" };
      }
      const cands = allBids(total, prev).slice(0, 30);
      let best = null, bv = -1e9;
      for (const b of cands) {
        const pt = probTrue(b, my, oppN);
        const mine = countFace(my, b.f);
        const exp = mine + oppN * (b.f === 1 ? 1 / 6 : 1 / 3);
        // prefer true-ish bids backed by own dice, small jumps; skill uses own-support to seed plausible bids
        let v = pt * (1 + 2.5 * skill) - (bidRank(b) - (prev ? bidRank(prev) : 0)) * 0.012 + (mine / Math.max(1, my.length)) * 0.6 * skill;
        if (b.q > exp + 1.5) v -= 2;
        v += (rng() - 0.5) * (0.4 + noise * 4);
        if (v > bv) { bv = v; best = b; }
      }
      // bluff: occasionally bid a face we do not hold, to mislead
      if (rng() < 0.05 + 0.18 * skill && cands.length > 2) {
        const weak = cands.filter((b) => countFace(my, b.f) === 0 && probTrue(b, my, oppN) > 0.3);
        if (weak.length) best = weak[0];
      }
      return best ? { t: "bid", q: best.q, f: best.f } : { t: "call" };
    }
    function create(seed) {
      return { seed, round: 0, dice: [[], []], bid: null, bidder: -1, turn: 0, starter: U.rng(seed + ":liars:first")() < 0.5 ? 0 : 1, over: false, winner: null, history: [] };
    }
    function roll(st) {
      st.round++;
      const rng = U.rng(st.seed + ":liars:r" + st.round);
      st.dice = st.dice.map((d, p) => (st.round === 1 ? [1, 2, 3, 4, 5] : d).map(() => 1 + Math.floor(rng() * 6)).sort((a, b) => a - b));
      st.bid = null; st.bidder = -1; st.turn = st.starter; st.history = [];
    }
    function apply(st, p, m) {
      if (st.over || p !== st.turn) throw new Error("liars: not your turn");
      if (m.t === "bid") {
        if (!higher(m, st.bid) || m.q < 1 || m.q > st.dice[0].length + st.dice[1].length || m.f < 1 || m.f > 6) throw new Error("liars: illegal bid");
        st.bid = { q: m.q, f: m.f }; st.bidder = p; st.turn = 1 - p; st.history.push({ p, q: m.q, f: m.f });
        return null;
      }
      if (!st.bid) throw new Error("liars: nothing to call");
      const n = countFace(st.dice[0], st.bid.f) + countFace(st.dice[1], st.bid.f);
      const loser = n >= st.bid.q ? p : st.bidder;
      const res = { caller: p, bidder: st.bidder, bid: st.bid, count: n, loser, dice: [st.dice[0].slice(), st.dice[1].slice()] };
      st.dice[loser] = st.dice[loser].slice(1);
      st.starter = loser;
      if (!st.dice[loser].length) { st.over = true; st.winner = 1 - loser; }
      return res;
    }
    function simulate(n, seed0, skills) {
      const out = { games: 0, wins: [0, 0], maxTurns: 0, violations: [] };
      for (let g = 0; g < n; g++) {
        const st = create(seed0 + ":" + g), rng = U.rng("ld-sim-" + seed0 + g);
        const sk = skills || [0.1 + 0.85 * rng(), 0.1 + 0.85 * rng()];
        let turns = 0; roll(st);
        while (!st.over && turns < 2000) {
          const p = st.turn, m = choose(st, p, sk[p], rng);
          try { const r = apply(st, p, m); if (r && !st.over) roll(st); } catch (e) { out.violations.push(String(e)); break; }
          turns++;
          if (st.dice[0].length + st.dice[1].length > 10) { out.violations.push("dice grew"); break; }
        }
        if (!st.over) out.violations.push("no termination " + g);
        out.games++; out.maxTurns = Math.max(out.maxTurns, turns); if (st.winner != null) out.wins[st.winner]++;
      }
      return out;
    }
    return { create, roll, apply, choose, simulate, allBids, higher, minQty, countFace, probTrue };
  })();

  const PIPS = { 1: [[50, 50]], 2: [[27, 27], [73, 73]], 3: [[27, 27], [50, 50], [73, 73]], 4: [[27, 27], [73, 27], [27, 73], [73, 73]],
    5: [[27, 27], [73, 27], [50, 50], [27, 73], [73, 73]], 6: [[27, 25], [73, 25], [27, 50], [73, 50], [27, 75], [73, 75]] };
  const dieSVG = (f, cls) => `<svg class="g-liars-die ${cls || ""}" viewBox="0 0 100 100" aria-label="${f || "hidden"}"><rect x="4" y="4" width="92" height="92" rx="18"/>${f ? PIPS[f].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="9.5"/>`).join("") : `<text x="50" y="66" text-anchor="middle">?</text>`}</svg>`;
  const nDice = (n) => n + (n === 1 ? " die" : " dice");
  const bidTxt = (b) => `${b.q} × <span class="g-liars-inl">${dieSVG(b.f, "mini")}</span>`;

  DG.css("liars", `
    .g-liars{display:grid;gap:12px}
    .g-liars-side{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);padding:10px 12px;display:grid;gap:8px}
    .g-liars-side.me{border-color:color-mix(in srgb,var(--gold) 45%,var(--line))}
    .g-liars-side.opp{border-color:color-mix(in srgb,var(--rival) 40%,var(--line))}
    .g-liars-hd{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
    .g-liars-dice{display:flex;gap:8px;flex-wrap:wrap;min-height:44px}
    .g-liars-die{width:44px;height:44px;flex:none}
    .g-liars-die rect{fill:#F6F2E8;stroke:#C9C2AE;stroke-width:3}
    .g-liars-die circle{fill:#17182A}
    .g-liars-die text{font:800 44px var(--f-body);fill:#9D9BC0}
    .g-liars-side.opp .g-liars-die.hid rect{fill:#2B2E57;stroke:#565B97}
    .g-liars-die.hit rect{fill:#FFE6A0;stroke:var(--gold);stroke-width:6}
    .g-liars-die.lost{opacity:.25}
    .g-liars-die.mini{width:20px;height:20px;vertical-align:-4px}
    .g-liars-inl{display:inline-block}
    .g-liars-roll{animation:g-liars-roll .5s ease-out}
    @keyframes g-liars-roll{0%{transform:rotate(-90deg) scale(.6);opacity:.3}100%{transform:none}}
    .g-liars-flip{animation:g-liars-flip .45s ease-out both}
    @keyframes g-liars-flip{0%{transform:rotateY(90deg)}100%{transform:none}}
    .g-liars-bid{text-align:center;display:grid;gap:4px;padding:6px 0}
    .g-liars-bid .big{font-family:var(--f-display);font-size:34px;line-height:1;text-transform:uppercase}
    .g-liars-bid .big .g-liars-die.mini{width:30px;height:30px;vertical-align:-3px}
    .g-liars-ctl{display:grid;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);padding:10px 12px}
    .g-liars-faces{display:grid;grid-template-columns:repeat(6,1fr);gap:6px}
    .g-liars-face{padding:4px;border-radius:var(--r-sm);background:var(--panel-2);border:1px solid var(--line);min-height:44px;display:grid;place-items:center}
    .g-liars-face .g-liars-die{width:34px;height:34px}
    .g-liars-face[aria-pressed="true"]{border-color:var(--gold);background:color-mix(in srgb,var(--gold) 22%,var(--panel-2))}
    .g-liars-face:disabled{opacity:.3}
    .g-liars-qty{display:flex;gap:8px;align-items:center;justify-content:center}
    .g-liars-qty b{font-family:var(--f-mono);font-size:26px;min-width:44px;text-align:center}
    .g-liars-qty .dg-btn{min-width:44px;font-size:20px;padding:4px 10px}
    .g-liars-acts{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .g-liars-hist{font-size:13px;color:var(--muted);text-align:center;min-height:20px}
    .g-liars-msg{text-align:center;font-weight:700;min-height:24px}
  `);

  function liarsMatch(ctx, spect) {
    const st = LD.create(ctx.seed);
    const names = spect ? [ctx.players[0].name, ctx.players[1].name] : [ctx.me.name || "You", ctx.opponents[0].name];
    const skills = spect ? [ctx.players[0].skill, ctx.players[1].skill] : [0.75, ctx.opponents[0].skill];
    const aiRng = U.rng(ctx.seed + ":liars-ai");
    let reveal = null, auto = false, pending = false, fresh = true, msg = "", selF = 0, selQ = 1, calls = 0;
    const H = 0;
    const humanTurn = () => !spect && !auto && !st.over && !reveal && st.turn === H;
    function defaults() {
      const total = st.dice[0].length + st.dice[1].length;
      const faces = [2, 3, 4, 5, 6, 1];
      if (!selF || LD.minQty(selF, st.bid, total) == null) selF = faces.find((f) => LD.minQty(f, st.bid, total) != null) || 0;
      if (selF) selQ = Math.max(selQ, LD.minQty(selF, st.bid, total));
      if (selF && !LD.higher({ q: selQ, f: selF }, st.bid)) selQ = LD.minQty(selF, st.bid, total);
      selQ = Math.min(selQ, total);
    }
    function side(p) {
      const show = spect || p === H || reveal;
      const d = reveal ? reveal.dice[p] : st.dice[p];
      const hit = (f) => reveal && (f === reveal.bid.f || (reveal.bid.f !== 1 && f === 1));
      const lost = reveal && reveal.loser === p;
      const dice = d.map((f, i) => dieSVG(show ? f : 0, (show ? "" : "hid ") + (hit(f) ? "hit " : "") + (lost && i === 0 ? "lost " : "") + (reveal && p !== H && !spect ? "g-liars-flip" : fresh ? "g-liars-roll" : ""))).join("");
      return `<div class="g-liars-side ${p === H && !spect ? "me" : p === 0 ? "me" : "opp"}" data-test="ld-side-${p === H ? "me" : "opp"}">
        <div class="g-liars-hd"><b class="${p === 0 ? "dg-gold" : "dg-rival"}">${esc(names[p])}</b><span class="dg-mono dg-muted">${nDice(st.dice[p].length)}${st.turn === p && !reveal && !st.over ? " · to move" : ""}</span></div>
        <div class="g-liars-dice">${dice}</div></div>`;
    }
    function render() {
      if (ctx.signal.ended) return;
      const total = st.dice[0].length + st.dice[1].length;
      const cur = st.bid ? `<div class="big" data-test="ld-bid"><span class="${st.bidder === 0 ? "dg-gold" : "dg-rival"}">${bidTxt(st.bid)}</span></div><div class="dg-note">${esc(subj(names[st.bidder], !spect && st.bidder === H, "bids"))} at least ${st.bid.f === 1 ? st.bid.q + (st.bid.q === 1 ? " one" : " ones") : nDice(st.bid.q) + " showing " + st.bid.f + " (1s count as wild)"} among all ${total} dice</div>`
        : `<div class="big dg-muted" data-test="ld-bid">No bid yet</div><div class="dg-note">Round ${st.round} · ${esc(subj(names[st.turn], !spect && st.turn === H, "opens"))}</div>`;
      const hist = st.history.slice(-5).map((h) => `<span class="${h.p === 0 ? "dg-gold" : "dg-rival"}">${bidTxt(h)}</span>`).join(" → ");
      let ctl = "";
      if (humanTurn()) {
        defaults();
        const faces = [1, 2, 3, 4, 5, 6].map((f) => `<button class="g-liars-face" data-test="ld-face" data-f="${f}" aria-pressed="${f === selF}" ${LD.minQty(f, st.bid, total) == null ? "disabled" : ""} aria-label="face ${f}">${dieSVG(f)}</button>`).join("");
        const okBid = selF && LD.higher({ q: selQ, f: selF }, st.bid) && selQ <= total;
        ctl = `<div class="g-liars-ctl" data-test="ld-ctl"><div class="dg-eyebrow dg-center">Your bid · pick a face and a quantity</div>
          <div class="g-liars-faces">${faces}</div>
          <div class="g-liars-qty"><button class="dg-btn" data-test="ld-minus" ${selF && selQ > LD.minQty(selF, st.bid, total) ? "" : "disabled"} aria-label="fewer">−</button><b data-test="ld-q">${selQ}</b><button class="dg-btn" data-test="ld-plus" ${selQ < total ? "" : "disabled"} aria-label="more">+</button></div>
          <div class="g-liars-acts"><button class="dg-btn danger" data-test="ld-call" ${st.bid ? "" : "disabled"}>Call liar</button>
          <button class="dg-btn primary" data-test="ld-raise" ${okBid ? "" : "disabled"}>Bid ${selQ} × ${selF || "?"}</button></div></div>`;
      } else if (reveal && !spect && !auto && !st.over) {
        ctl = `<div class="g-liars-ctl"><button class="dg-btn primary" data-test="ld-next">Next round</button></div>`;
      }
      ctx.root.innerHTML = `<div class="g-liars" data-test="liars">${side(1)}
        <div class="g-liars-bid">${cur}<div class="g-liars-hist">${hist}</div></div>
        <div class="g-liars-msg" data-test="ld-msg" aria-live="polite">${msg}</div>
        ${ctl}${side(0)}
        <p class="dg-note dg-center" style="margin:0">1s are wild (count as any face) unless the bid is on 1s. A bid on 1s needs about half the quantity.</p></div>`;
      fresh = false;
      ctx.setStatus(st.over ? "Game over" : `Round ${st.round} · ${reveal ? "Reveal" : spect ? short(names[st.turn]) : st.turn === H ? "Your move" : "Rival's move"} · dice ${st.dice[0].length}–${st.dice[1].length}`);
      const q = (s) => ctx.root.querySelector(s);
      if (humanTurn()) {
        ctx.root.querySelectorAll("[data-test=ld-face]").forEach((b) => b.addEventListener("click", () => { selF = +b.dataset.f; selQ = LD.minQty(selF, st.bid, total) || selQ; render(); }));
        q("[data-test=ld-minus]").addEventListener("click", () => { selQ--; render(); });
        q("[data-test=ld-plus]").addEventListener("click", () => { selQ++; render(); });
        q("[data-test=ld-call]").addEventListener("click", () => act(H, { t: "call" }));
        q("[data-test=ld-raise]").addEventListener("click", () => act(H, { t: "bid", q: selQ, f: selF }));
      }
      const nb = q("[data-test=ld-next]"); if (nb) nb.addEventListener("click", nextRound);
    }
    function act(p, m) {
      if (ctx.signal.ended || st.over || reveal || st.turn !== p) return;
      if (m.t === "bid" && !LD.higher(m, st.bid)) return;
      const r = LD.apply(st, p, m);
      if (!r) { msg = `<span class="${p === 0 ? "dg-gold" : "dg-rival"}">${esc(subj(names[p], !spect && p === H, "bids"))}</span> ${bidTxt(m)}`; render(); return schedule(); }
      calls++;
      reveal = r;
      const liar = r.count < r.bid.q;
      msg = `<span class="${p === 0 ? "dg-gold" : "dg-rival"}">${esc(subj(names[p], !spect && p === H, "calls"))}</span> liar! There ${r.count === 1 ? "is" : "are"} <b>${r.count}</b> — ${liar ? "the bid was a bluff" : "the bid stands"}. <span class="${r.loser === 0 ? "dg-gold" : "dg-rival"}">${esc(subj(names[r.loser], !spect && r.loser === H, "loses"))}</span> a die.`;
      render();
      if (st.over) return finish();
      if (spect || auto) ctx.timeout(nextRound, auto && !spect ? 120 : 2600);
    }
    function nextRound() {
      if (ctx.signal.ended || st.over || !reveal) return;
      reveal = null; msg = ""; selF = 0; selQ = 1; fresh = true;
      LD.roll(st); render(); schedule();
    }
    function schedule() {
      if (ctx.signal.ended || st.over || reveal) return;
      const p = st.turn;
      if (spect || auto || p !== H) {
        if (pending) return; pending = true;
        ctx.timeout(() => { pending = false; if (!reveal && st.turn === p) act(p, LD.choose(st, p, skills[p], aiRng)); }, auto && !spect ? 40 : spect ? 900 + 500 * aiRng() : 600 + 500 * aiRng());
      }
    }
    function finish() {
      ctx.timeout(() => {
        const a = st.dice[0].length, b = st.dice[1].length;
        if (spect) return ctx.end({ winner: st.winner, scores: [a, b] });
        const win = st.winner === H;
        ctx.end({ outcome: win ? "win" : "loss", myScore: a, oppScore: b, detail: `<p class="dg-note">${win ? "You kept " + nDice(a) + "." : esc(names[1]) + " kept " + nDice(b) + "."} ${st.round} round${st.round === 1 ? "" : "s"}, ${calls} challenge${calls === 1 ? "" : "s"}.</p>` });
      }, spect ? 2600 : 2200);
    }
    ctx.test = {
      state: () => ({ round: st.round, turn: st.turn, bid: st.bid, dice: [st.dice[0].slice(), st.dice[1].length], over: st.over, winner: st.winner, reveal: !!reveal }),
      autoplay() { auto = true; if (reveal) ctx.timeout(nextRound, 60); else if (!pending) schedule(); render(); return true; },
      simulate: (n, seed, sk) => LD.simulate(n, seed, sk),
    };
    LD.roll(st); render(); schedule();
  }

  DG.registerGame({
    id: "liars", name: "Liar's Dice", category: "dice", kind: "versus", formats: ["1v1", "tournament"],
    skill: 5, luck: 5, cashEligible: false, duration: "5 min", pack: "social",
    blurb: "Hide your dice, bid on everyone's, and call the bluff at the right moment.",
    rules: [
      "Each player rolls five hidden dice. You see only your own.",
      "Bid how many dice of one face are on the table in total, e.g. \"4 × 5\". 1s are wild unless the bid is on 1s.",
      "Each bid must be higher: more dice, or the same number with a higher face. A bid on 1s counts double.",
      "Instead of bidding, call liar. If the bid is short, the bidder loses a die; otherwise the caller does.",
      "The loser of a challenge opens the next round. Lose all your dice and you lose the match.",
    ],
    scoreLabel: "dice",
    play(ctx) { liarsMatch(ctx, false); },
    spectate(ctx) { liarsMatch(ctx, true); },
  });

  /* =====================================================================
     5. AUCTION DUEL (sealed first-price, 6 lots)
     ===================================================================== */
  const AU_ITEMS = [
    ["Vintage roadster", "Collector car"], ["Harbour warehouse", "Property"], ["Oil painting, 1890s", "Fine art"], ["Rare stamp sheet", "Collectible"],
    ["Racehorse yearling", "Livestock"], ["Mining claim", "Commodity"], ["Tech start-up stake", "Equity"], ["Vineyard plot", "Land"],
    ["Antique grandfather clock", "Antique"], ["Signed first edition", "Book"], ["Patent portfolio", "Intellectual property"], ["Classic motorboat", "Vehicle"],
    ["Gold bullion lot", "Commodity"], ["Marble sculpture", "Fine art"], ["Downtown parking lot", "Property"], ["Film rights", "Media"],
  ];
  const AU_ROUNDS = 6, AU_CASH = 10000;
  function auSetup(seed) {
    const rng = U.rng(seed + ":auction");
    const items = U.shuffle(rng, AU_ITEMS).slice(0, AU_ROUNDS);
    return items.map(([name, kind], i) => {
      const base = 900 + Math.round(rng() * 22) * 100;              // public ballpark 900..3100
      const value = Math.max(200, Math.round((base * (0.55 + 0.9 * rng())) / 10) * 10); // true value
      const spread = Math.round(value * (0.18 + 0.12 * rng()) / 10) * 10;
      const sig = () => Math.max(50, Math.round((value + (rng() * 2 - 1) * spread) / 10) * 10);
      const me = sig(), opp = sig();
      const lo = Math.round(Math.max(0, base * 0.5) / 100) * 100, hi = Math.round(base * 1.5 / 100) * 100;
      return { i, name, kind, value, hint: { lo, hi }, sig: [me, opp], spread, coin: rng() < 0.5 ? 0 : 1 };
    });
  }
  function auBid(lot, p, cash, oppCash, roundsLeft, skill, rng) {
    /* Sealed first-price bid. With symmetric noisy signals the best response (found by simulation) is to
       bid ~85% of your own estimate. Skill = how close to that and how consistently: weak players drift
       (over-trusting a high signal, or timid), strong players shade tightly and manage budget. */
    const est = lot.sig[p], mid = (lot.hint.lo + lot.hint.hi) / 2;
    const e = est * (0.8 + 0.2 * skill) + mid * (0.2 - 0.2 * skill);
    const bias = (1 - skill) * (rng() < 0.5 ? 0.12 : -0.18);
    let b = e * (0.85 + bias + U.gauss(rng) * (0.015 + 0.13 * (1 - skill)));
    if (skill > 0.5 && oppCash < b) b = Math.min(b, oppCash + 10);
    const reserve = roundsLeft > 1 ? Math.min(cash * 0.5, (roundsLeft - 1) * 700 * skill) : 0;
    b = Math.min(b, Math.max(0, cash - reserve));
    return clamp(Math.round(b / 10) * 10, 0, cash);
  }
  function auResolve(lot, bids) {
    if (bids[0] === bids[1]) return bids[0] === 0 ? -1 : lot.coin;
    return bids[0] > bids[1] ? 0 : 1;
  }
  function auSimulate(n, seed0, skills) {
    const out = { games: 0, wins: [0, 0], draws: 0 };
    for (let g = 0; g < n; g++) {
      const lots = auSetup(seed0 + ":" + g), rng = U.rng("au-sim" + seed0 + g), cash = [AU_CASH, AU_CASH], val = [0, 0];
      lots.forEach((lot, r) => {
        const b = [0, 1].map((p) => auBid(lot, p, cash[p], cash[1 - p], AU_ROUNDS - r, skills[p], rng));
        const w = auResolve(lot, b);
        if (w >= 0) { cash[w] -= b[w]; val[w] += lot.value; }
      });
      const nw = [cash[0] + val[0], cash[1] + val[1]];
      out.games++; if (nw[0] === nw[1]) out.draws++; else out.wins[nw[0] > nw[1] ? 0 : 1]++;
    }
    return out;
  }

  DG.css("auction", `
    .g-auction{display:grid;gap:12px}
    .g-auction-top{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .g-auction-lot{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-lg);padding:14px;display:grid;gap:10px}
    .g-auction-lot h3{margin:0;font-family:var(--f-display);text-transform:uppercase;font-size:28px;line-height:1;letter-spacing:.02em}
    .g-auction-est{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .g-auction-est div{background:var(--panel-2);border:1px solid var(--line);border-radius:var(--r-md);padding:8px 10px}
    .g-auction-est b{display:block;font-family:var(--f-mono);font-size:17px}
    .g-auction-est .mine{border-color:color-mix(in srgb,var(--gold) 50%,var(--line))}
    .g-auction-bidrow{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center}
    .g-auction-bidrow input[type=number]{width:100%;min-height:44px;font:700 20px var(--f-mono);text-align:center;background:var(--panel-2);color:var(--fg);
      border:1px solid var(--line);border-radius:var(--r-sm)}
    .g-auction-bidrow .dg-btn{min-width:48px;padding:6px 8px}
    .g-auction-quick{display:flex;gap:6px;flex-wrap:wrap;justify-content:center}
    .g-auction-quick .dg-chip{font-family:var(--f-mono);font-size:13px;min-height:36px}
    .g-auction-range{-webkit-appearance:none;appearance:none;width:100%;height:36px;background:transparent;cursor:pointer;touch-action:manipulation;margin:0}
    .g-auction-range::-webkit-slider-runnable-track{height:10px;border-radius:99px;background:var(--panel-3);border:1px solid var(--line)}
    .g-auction-range::-moz-range-track{height:10px;border-radius:99px;background:var(--panel-3);border:1px solid var(--line)}
    .g-auction-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:30px;height:30px;margin-top:-11px;border-radius:50%;background:var(--gold);border:3px solid var(--on-gold);box-shadow:0 1px 6px rgba(0,0,0,.5)}
    .g-auction-range::-moz-range-thumb{width:30px;height:30px;border-radius:50%;background:var(--gold);border:3px solid var(--on-gold)}
    .g-auction-res{text-align:center;font-weight:700;min-height:24px}
    .g-auction-seal{display:flex;justify-content:center;gap:10px;flex-wrap:wrap}
    .g-auction-seal span{padding:8px 14px;border-radius:var(--r-md);background:var(--panel-2);border:1px solid var(--line);font-family:var(--f-mono)}
    .g-auction-tbl td,.g-auction-tbl th{padding:6px 5px;font-size:13px}
    @media (max-width:440px){.g-auction-tbl td,.g-auction-tbl th{padding:5px 3px;font-size:11.5px;letter-spacing:0}.g-auction-tbl .pf{display:none}}
    .g-auction-coin{display:inline-block;width:18px;height:18px;border-radius:50%;background:var(--gold);vertical-align:-3px;margin-right:4px}
  `);

  function auctionMatch(ctx, spect) {
    const lots = auSetup(ctx.seed);
    const names = spect ? [ctx.players[0].name, ctx.players[1].name] : [ctx.me.name || "You", ctx.opponents[0].name];
    const skills = spect ? [ctx.players[0].skill, ctx.players[1].skill] : [0.75, ctx.opponents[0].skill];
    const aiRng = U.rng(ctx.seed + ":auction-ai");
    const cash = [AU_CASH, AU_CASH], won = [[], []], log = [];
    let r = 0, phase = "bid", bidVal = 0, auto = false, last = null;
    const H = 0;
    const col = (p) => (p === 0 ? "dg-gold" : "dg-rival");
    function statBox(p) {
      return `<div class="dg-stat" data-test="au-${p === 0 ? "me" : "opp"}"><span class="dg-eyebrow ${col(p)}">${esc(names[p])}</span><b>${money(cash[p])}</b>
        <span class="dg-note">${won[p].length} lot${won[p].length === 1 ? "" : "s"} won</span></div>`;
    }
    function render() {
      if (ctx.signal.ended) return;
      const lot = lots[r];
      if (phase === "final") return renderFinal();
      const seeMine = spect ? `<div class="mine"><span class="dg-eyebrow dg-gold">${esc(names[0])}'s estimate</span><b>${money(lot.sig[0] - lot.spread)}–${money(lot.sig[0] + lot.spread)}</b></div>`
        : `<div class="mine"><span class="dg-eyebrow dg-gold">Your private estimate</span><b data-test="au-est">${money(Math.max(0, lot.sig[0] - lot.spread))}–${money(lot.sig[0] + lot.spread)}</b></div>`;
      const pub = `<div><span class="dg-eyebrow">Public guide</span><b>${money(lot.hint.lo)}–${money(lot.hint.hi)}</b></div>`;
      let body = "";
      if (phase === "bid" && !spect && !auto) {
        bidVal = clamp(bidVal, 0, cash[H]);
        const quick = [0, 0.6, 0.75, 0.9].map((f) => Math.min(cash[H], Math.round((lot.sig[0] * f) / 50) * 50));
        body = `<div class="dg-eyebrow">Your sealed bid (max ${money(cash[H])})</div>
          <div class="g-auction-bidrow"><button class="dg-btn" data-test="au-minus" aria-label="minus 100">−100</button>
            <input type="number" inputmode="numeric" min="0" max="${cash[H]}" step="10" value="${bidVal}" data-test="au-input" aria-label="bid amount">
            <button class="dg-btn" data-test="au-plus" aria-label="plus 100">+100</button></div>
          <input class="g-auction-range" type="range" min="0" max="${cash[H]}" step="10" value="${bidVal}" data-test="au-range" aria-label="bid slider">
          <div class="g-auction-quick">${quick.map((v) => `<button class="dg-chip" data-q="${v}">${v ? money(v) : "Pass ($0)"}</button>`).join("")}</div>
          <button class="dg-btn primary" data-test="au-bid">Seal bid · ${money(bidVal)}</button>`;
      } else if (phase === "bid") {
        body = `<div class="g-auction-seal"><span>${esc(names[0])}: sealing…</span><span>${esc(names[1])}: sealing…</span></div>`;
      } else if (phase === "result") {
        const L = last;
        body = `<div class="g-auction-seal" data-test="au-bids"><span class="${col(0)}">${esc(names[0])} ${money(L.bids[0])}</span><span class="${col(1)}">${esc(names[1])} ${money(L.bids[1])}</span></div>
          <div class="g-auction-res" data-test="au-res">${L.w < 0 ? "No bids — the lot goes unsold." : `${L.tie ? '<span class="g-auction-coin"></span>Tie, settled by the coin: ' : ""}<span class="${col(L.w)}">${esc(subj(names[L.w], !spect && L.w === H, "wins"))}</span> for ${money(L.bids[L.w])}. True value stays hidden until the end.`}</div>
          ${!spect && !auto ? `<button class="dg-btn primary" data-test="au-next">${r + 1 < AU_ROUNDS ? "Next lot" : "Reveal values"}</button>` : ""}`;
      }
      ctx.root.innerHTML = `<div class="g-auction" data-test="auction">
        <div class="g-auction-top">${statBox(0)}${statBox(1)}</div>
        <div class="g-auction-lot"><div class="dg-eyebrow">Lot ${r + 1} of ${AU_ROUNDS} · ${esc(lot.kind)}</div><h3 data-test="au-lot">${esc(lot.name)}</h3>
          <div class="g-auction-est">${pub}${seeMine}</div>
          ${body}</div>
        <p class="dg-note dg-center" style="margin:0">Sealed first-price bids: the higher bid wins and pays its own bid. Final score = cash + true value of lots won.</p></div>`;
      ctx.setStatus(`Lot ${r + 1}/${AU_ROUNDS} · ${phase === "bid" ? "Bid" : "Result"}`);
      wire();
    }
    function wire() {
      const q = (s) => ctx.root.querySelector(s);
      const inp = q("[data-test=au-input]");
      if (inp) {
        const set = (v, from) => {
          bidVal = clamp(Math.round((+v || 0) / 10) * 10, 0, cash[H]);
          if (from !== "inp") inp.value = bidVal;
          q("[data-test=au-range]").value = bidVal;
          q("[data-test=au-bid]").textContent = "Seal bid · " + money(bidVal);
        };
        inp.addEventListener("input", () => set(inp.value, "inp"));
        inp.addEventListener("change", () => set(inp.value));
        q("[data-test=au-range]").addEventListener("input", (e) => set(e.target.value));
        q("[data-test=au-minus]").addEventListener("click", () => set(bidVal - 100));
        q("[data-test=au-plus]").addEventListener("click", () => set(bidVal + 100));
        ctx.root.querySelectorAll("[data-q]").forEach((b) => b.addEventListener("click", () => set(b.dataset.q)));
        q("[data-test=au-bid]").addEventListener("click", () => { set(inp.value); seal(bidVal); });
      }
      const nx = q("[data-test=au-next]"); if (nx) nx.addEventListener("click", advance);
    }
    function seal(myBid) {
      if (phase !== "bid" || ctx.signal.ended) return;
      const lot = lots[r];
      const bids = [spect || auto ? auBid(lot, 0, cash[0], cash[1], AU_ROUNDS - r, skills[0], aiRng) : clamp(myBid, 0, cash[0]),
        auBid(lot, 1, cash[1], cash[0], AU_ROUNDS - r, skills[1], aiRng)];
      const w = auResolve(lot, bids);
      if (w >= 0) { cash[w] -= bids[w]; won[w].push(r); }
      last = { bids, w, tie: bids[0] === bids[1] && w >= 0 };
      log.push(last);
      phase = "result"; render();
      if (spect || auto) ctx.timeout(advance, auto && !spect ? 60 : 2200);
    }
    function advance() {
      if (phase !== "result" || ctx.signal.ended) return;
      r++; bidVal = 0;
      if (r >= AU_ROUNDS) { phase = "final"; render(); return finish(); }
      phase = "bid"; render();
      if (spect || auto) ctx.timeout(() => seal(0), auto && !spect ? 60 : 1600);
    }
    const nw = (p) => cash[p] + won[p].reduce((s, i) => s + lots[i].value, 0);
    function renderFinal() {
      const rows = lots.map((lot, i) => {
        const L = log[i];
        const w = L.w, paid = w >= 0 ? L.bids[w] : 0, gain = w >= 0 ? lot.value - paid : 0;
        return `<tr><td>${esc(lot.name)}</td><td class="num">${money(L.bids[0])}</td><td class="num">${money(L.bids[1])}</td>
          <td class="${w < 0 ? "dg-muted" : col(w)}">${w < 0 ? "—" : esc(names[w])}</td><td class="num">${money(lot.value)}</td><td class="num pf ${gain >= 0 ? "dg-good" : "dg-bad"}">${w < 0 ? "" : (gain >= 0 ? "+" : "−") + money(Math.abs(gain))}</td></tr>`;
      }).join("");
      const a = nw(0), b = nw(1);
      ctx.root.innerHTML = `<div class="g-auction" data-test="auction">
        <div class="g-auction-top">${[0, 1].map((p) => `<div class="dg-stat" data-test="au-nw-${p}"><span class="dg-eyebrow ${col(p)}">${esc(names[p])} · net worth</span><b>${money(nw(p))}</b><span class="dg-note">${money(cash[p])} cash + ${money(nw(p) - cash[p])} in lots</span></div>`).join("")}</div>
        <div class="g-auction-res">${a === b ? "Dead heat" : `<span class="${col(a > b ? 0 : 1)}">${esc(subj(names[a > b ? 0 : 1], !spect && a > b, "wins"))}</span> by ${money(Math.abs(a - b))}`}</div>
        <div class="dg-box dg-scroll-x" style="padding:8px"><table class="dg-table g-auction-tbl" data-test="au-reveal"><thead><tr><th>Lot</th><th class="num">${esc(names[0])}</th><th class="num">${esc(names[1])}</th><th>Won by</th><th class="num">Value</th><th class="num pf">Profit</th></tr></thead><tbody>${rows}</tbody></table></div>
        ${spect ? "" : `<button class="dg-btn primary" data-test="au-finish" style="justify-self:center">See result</button>`}</div>`;
      ctx.setStatus("Final values");
      const fb = ctx.root.querySelector("[data-test=au-finish]"); if (fb) fb.addEventListener("click", () => endNow && endNow());
    }
    let endNow = null;
    function finish() {
      const a = nw(0), b = nw(1);
      endNow = () => {
        if (spect) return ctx.end({ winner: a === b ? -1 : a > b ? 0 : 1, scores: [a, b] });
        ctx.end({ outcome: a === b ? "draw" : a > b ? "win" : "loss", myScore: a, oppScore: b, detail: `<p class="dg-note">Net worth ${money(a)} vs ${money(b)}. You won ${won[0].length} of ${AU_ROUNDS} lots.</p>` });
      };
      ctx.timeout(endNow, spect || auto ? 3500 : 15000);
    }
    ctx.test = {
      state: () => ({ round: r, phase, cash: cash.slice(), won: won.map((x) => x.slice()), sig: lots[Math.min(r, AU_ROUNDS - 1)].sig[0], netWorth: phase === "final" ? [nw(0), nw(1)] : null }),
      autoplay() { auto = true; if (phase === "bid") seal(0); else if (phase === "result") advance(); return true; },
      simulate: (n, seed, sk) => auSimulate(n, seed, sk),
    };
    render();
    if (spect) ctx.timeout(() => seal(0), 1600);
  }

  DG.registerGame({
    id: "auction", name: "Auction Duel", category: "social", kind: "versus", formats: ["1v1", "tournament"],
    skill: 7, luck: 3, cashEligible: false, duration: "3 min", pack: "social",
    blurb: "Six lots, sealed bids, hidden values. Outbid your rival — but never overpay.",
    rules: [
      "You both start with $10,000. Six lots come up one by one.",
      "Each lot has a hidden true value. You see a public guide and your own private estimate range; your rival has its own estimate.",
      "Both seal one bid. The higher bid wins the lot and pays its own bid. Ties are settled by a coin.",
      "After lot six the true values are revealed. Net worth = cash left + true value of lots won.",
      "Higher net worth wins. Bidding $0 passes.",
    ],
    scoreLabel: "net worth",
    formatScore: (n) => money(n),
    play(ctx) { auctionMatch(ctx, false); },
    spectate(ctx) { auctionMatch(ctx, true); },
  });

  DG._socialData = { TRIVIA, TV_CATS, triviaSet, WG, wgPuzzle, DK, LD, auSetup, auBid, auSimulate };
})();
