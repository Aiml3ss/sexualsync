// The Sex Quiz deck — the static set of desire cards each partner rates.
//
// The server only ever stores ratings keyed by `id`; everything human-facing
// (label, emoji, copy, role/edge flags) lives here on the client. Cards are
// listed in deal order: gentle first, edge last, so the quiz eases couples in.
//
// - role: true  -> the card shows a Give / Receive / Both choice
// - edge: true  -> "edge" card. Carries a consent line; a Pass on an edge card
//   can be filed to Limits, and edge cards sort to the end of the deck.

export type QuizInterest = "pass" | "curious" | "into";
export type QuizRole = "give" | "receive" | "both";

export interface QuizCard {
  id: string;
  category: string;
  label: string;
  emoji: string;
  desc: string;
  role: boolean;
  edge: boolean;
}

export interface QuizCategory {
  id: string;
  title: string;
}

export const QUIZ_CATEGORIES: QuizCategory[] = [
  { id: "warmup", title: "Warm-up & sensual" },
  { id: "mouths", title: "Mouths & hands" },
  { id: "positions", title: "Positions & places" },
  { id: "tempo", title: "Tempo & energy" },
  { id: "power", title: "Power play" },
  { id: "restraint", title: "Restraint & sensation" },
  { id: "roleplay", title: "Roleplay & fantasy" },
  { id: "toys", title: "Toys & props" },
  { id: "watch", title: "Watch & capture" },
  { id: "words", title: "Words & care" },
  { id: "requests", title: "Dirty requests" },
  { id: "cumplay", title: "Finish & cum play" },
  { id: "anal", title: "Anal" },
  { id: "others", title: "Opening up" },
  { id: "heavier", title: "Heavier kink" },
];

export const QUIZ_DECK: QuizCard[] = [
  // 1. Warm-up & sensual
  { id: "makeouts", category: "warmup", label: "Long makeouts", emoji: "💋", desc: "Kissing as the main event.", role: false, edge: false },
  { id: "massage", category: "warmup", label: "Sensual massage", emoji: "💆", desc: "Oil, hands, no rush.", role: true, edge: false },
  { id: "striptease", category: "warmup", label: "Striptease", emoji: "🔥", desc: "Undressing slowly for each other.", role: true, edge: false },
  { id: "teasing", category: "warmup", label: "Teasing & edging foreplay", emoji: "⏳", desc: "Drawing it out on purpose.", role: true, edge: false },
  { id: "shower", category: "warmup", label: "Shower or bath together", emoji: "🚿", desc: "Wet, warm, close.", role: false, edge: false },
  { id: "dryhump", category: "warmup", label: "Dry humping / grinding", emoji: "👖", desc: "Clothes on, friction only.", role: false, edge: false },
  { id: "undresseachother", category: "warmup", label: "Undress each other slowly", emoji: "🎀", desc: "One piece at a time.", role: true, edge: false },
  { id: "neckkissing", category: "warmup", label: "Neck & ear kissing", emoji: "👂", desc: "The spots that get you.", role: true, edge: false },

  // 2. Mouths & hands
  { id: "oral", category: "mouths", label: "Oral", emoji: "👅", desc: "Giving or receiving.", role: true, edge: false },
  { id: "sixtynine", category: "mouths", label: "69", emoji: "😋", desc: "At the same time.", role: false, edge: false },
  { id: "handwork", category: "mouths", label: "Fingering / handwork", emoji: "✋", desc: "Hands doing the work.", role: true, edge: false },
  { id: "facesitting", category: "mouths", label: "Face-sitting", emoji: "🪑", desc: "Sitting on their face.", role: true, edge: false },
  { id: "mutualmasturbation", category: "mouths", label: "Mutual masturbation", emoji: "🤲", desc: "Hands on each other at once.", role: false, edge: false },
  { id: "handedge", category: "mouths", label: "Hand edging", emoji: "🖐️", desc: "Edged by hand, over and over.", role: true, edge: false },
  { id: "eatmeoutshaking", category: "mouths", label: "Eat me out until I'm shaking", emoji: "👅", desc: "Oral, all the way there.", role: true, edge: false },
  { id: "mouthfingersher", category: "mouths", label: "Mouth and fingers on her at once", emoji: "👅", desc: "Tongue and hands together.", role: true, edge: false },
  { id: "ballplay", category: "mouths", label: "Ball play", emoji: "🥎", desc: "Licking, sucking, attention there.", role: true, edge: false },
  { id: "gspot", category: "mouths", label: "Finger me to my G-spot", emoji: "👆", desc: "Come-hither, all the way.", role: true, edge: false },

  // 3. Positions & places
  { id: "newposition", category: "positions", label: "Try a new position", emoji: "🤸", desc: "Something you haven't done.", role: false, edge: false },
  { id: "frombehind", category: "positions", label: "From behind", emoji: "🍑", desc: "Doggy and variations.", role: false, edge: false },
  { id: "ontop", category: "positions", label: "On top / riding", emoji: "🤠", desc: "Who takes the lead on top.", role: true, edge: false },
  { id: "standing", category: "positions", label: "Against the wall / standing", emoji: "🧍", desc: "Up against something.", role: false, edge: false },
  { id: "notbed", category: "positions", label: "Somewhere not the bed", emoji: "🛋️", desc: "Couch, floor, car, counter.", role: false, edge: false },
  { id: "quickie", category: "positions", label: "Quickie", emoji: "⚡", desc: "Fast and urgent.", role: false, edge: false },
  { id: "morning", category: "positions", label: "Morning wake-up sex", emoji: "🌅", desc: "Starting the day together.", role: false, edge: false },
  { id: "spooning", category: "positions", label: "Spooning sex", emoji: "🥄", desc: "Lazy, on your sides.", role: false, edge: false },
  { id: "reversecowgirl", category: "positions", label: "Reverse cowgirl", emoji: "🐎", desc: "On top, facing away.", role: false, edge: false },
  { id: "carsex", category: "positions", label: "Car sex", emoji: "🚗", desc: "Cramped and steamy.", role: false, edge: false },
  { id: "outdoors", category: "positions", label: "Outdoors", emoji: "🌲", desc: "Open air, in nature.", role: false, edge: false },
  { id: "semipublic", category: "positions", label: "Semi-public", emoji: "🫣", desc: "Where you might get caught.", role: false, edge: true },
  { id: "hotel", category: "positions", label: "A night somewhere new", emoji: "🏨", desc: "Hotel, getaway, fresh sheets.", role: false, edge: false },
  { id: "edgeofbed", category: "positions", label: "On the edge of the bed", emoji: "🛏️", desc: "Pulled to the edge, standing over you.", role: false, edge: false },
  { id: "deepmissionary", category: "positions", label: "Deep missionary", emoji: "😮‍💨", desc: "Knees to your chest, as deep as it goes.", role: false, edge: false },
  { id: "legsonshoulders", category: "positions", label: "Legs on your shoulders", emoji: "🦵", desc: "Ankles up, all the way in.", role: false, edge: false },
  { id: "bentovertable", category: "positions", label: "Bent over a table", emoji: "🍽️", desc: "Over whatever's nearest.", role: false, edge: false },
  { id: "lotus", category: "positions", label: "Lotus", emoji: "🧘", desc: "Wrapped around each other, sitting up.", role: false, edge: false },
  { id: "carried", category: "positions", label: "Standing, lifted and carried", emoji: "🏋️", desc: "Picked up against the wall.", role: false, edge: false },
  { id: "sideentry", category: "positions", label: "Side entry / the pretzel", emoji: "🥨", desc: "Tangled, deep from the side.", role: false, edge: false },
  { id: "piledriver", category: "positions", label: "Pile driver", emoji: "🤸", desc: "Hips up, legs over your head.", role: false, edge: false },
  { id: "prone", category: "positions", label: "Face-down / prone", emoji: "🛌", desc: "Flat on your stomach, deep.", role: false, edge: false },
  { id: "standingbent", category: "positions", label: "Standing, bent over", emoji: "🧎", desc: "Bent forward, from behind.", role: false, edge: false },

  // 4. Tempo & energy
  { id: "slow", category: "tempo", label: "Slow & sensual", emoji: "🐢", desc: "Unhurried, drawn out.", role: false, edge: false },
  { id: "rough", category: "tempo", label: "Rough & intense", emoji: "🔥", desc: "Harder, more force.", role: true, edge: true },
  { id: "romantic", category: "tempo", label: "Passionate / romantic", emoji: "💞", desc: "Candles, eye contact, feeling.", role: false, edge: false },
  { id: "makeupsex", category: "tempo", label: "Make-up sex", emoji: "💢", desc: "The heat right after a fight.", role: false, edge: false },
  { id: "tantric", category: "tempo", label: "Tantric — slow, breath, eyes", emoji: "👁️", desc: "Drawn-out, locked-in connection.", role: false, edge: false },
  { id: "frantic", category: "tempo", label: "Frantic — clothes half-on", emoji: "🌪️", desc: "Can't-wait, can't-keep-hands-off.", role: false, edge: false },
  { id: "lazysex", category: "tempo", label: "Lazy / half-asleep", emoji: "😴", desc: "Barely moving, drifting.", role: false, edge: false },
  { id: "allnighter", category: "tempo", label: "All-nighter", emoji: "🌙", desc: "Take hours, no finish line.", role: false, edge: false },

  // 5. Power play
  { id: "control", category: "power", label: "Take control / be taken", emoji: "🎚️", desc: "One leads, one follows.", role: true, edge: false },
  { id: "orders", category: "power", label: "Give orders / follow them", emoji: "🫡", desc: "Telling or being told.", role: true, edge: false },
  { id: "begging", category: "power", label: "Begging", emoji: "🙏", desc: "Made to ask for it.", role: true, edge: false },
  { id: "pinned", category: "power", label: "Pinned down / hold them down", emoji: "✊", desc: "Held in place.", role: true, edge: true },
  { id: "orgasmcontrol", category: "power", label: "Orgasm control", emoji: "⏸️", desc: "Permission to finish.", role: true, edge: false },
  { id: "brat", category: "power", label: "Brat & tease", emoji: "😼", desc: "Playful defiance.", role: true, edge: false },
  { id: "worship", category: "power", label: "Body worship", emoji: "🙇", desc: "Adoring every inch.", role: true, edge: false },
  { id: "cnc-ravish", category: "power", label: "Pinned and 'taken'", emoji: "😈", desc: "Consensual ravishment — the safeword is always real.", role: true, edge: true },
  { id: "daddy-dynamic", category: "power", label: "\"Daddy\" / \"good girl\" energy", emoji: "👑", desc: "A caregiver power dynamic, either way.", role: true, edge: false },
  { id: "chastity", category: "power", label: "Chastity / kept on edge", emoji: "🔒", desc: "Locked up or denied 'til you say.", role: true, edge: true },
  { id: "freeuse", category: "power", label: "Free use — available anytime", emoji: "🔓", desc: "Use me whenever, within our rules.", role: true, edge: true },

  // 6. Restraint & sensation
  { id: "bondage", category: "restraint", label: "Light bondage", emoji: "🪢", desc: "Wrists, a ribbon, soft cuffs.", role: true, edge: true },
  { id: "blindfold", category: "restraint", label: "Blindfold", emoji: "🙈", desc: "Taking sight away.", role: true, edge: false },
  { id: "spanking", category: "restraint", label: "Spanking / impact", emoji: "🖐️", desc: "Open hand or more.", role: true, edge: true },
  { id: "hairpulling", category: "restraint", label: "Hair pulling", emoji: "💁", desc: "A fistful, a tug.", role: true, edge: false },
  { id: "biting", category: "restraint", label: "Biting / marking", emoji: "🦷", desc: "Teeth, hickeys.", role: true, edge: true },
  { id: "temperature", category: "restraint", label: "Temperature", emoji: "🧊", desc: "Ice or warm wax.", role: true, edge: true },
  { id: "breath", category: "restraint", label: "Breath / light choking", emoji: "🤏", desc: "Consent-first, a hand at the throat.", role: true, edge: true },
  { id: "sensory", category: "restraint", label: "Sensory teasing", emoji: "🪶", desc: "Feathers, nails, textures.", role: true, edge: false },
  { id: "nippleplay", category: "restraint", label: "Nipple play", emoji: "🌸", desc: "Licking, sucking, teasing.", role: true, edge: false },
  { id: "nippleclamps", category: "restraint", label: "Nipple clamps", emoji: "🗜️", desc: "That bite of pressure.", role: true, edge: true },
  { id: "gagged", category: "restraint", label: "Gagged", emoji: "🤐", desc: "Muffled — a hand or a gag.", role: true, edge: true },
  { id: "sensorydep", category: "restraint", label: "Senses cut — blindfold + silence", emoji: "🙉", desc: "Sight and sound taken away.", role: true, edge: true },
  { id: "tickling", category: "restraint", label: "Tickling", emoji: "😆", desc: "Playful, squirming, helpless.", role: true, edge: false },
  { id: "tiedtobed", category: "restraint", label: "Tied to the bed", emoji: "🛏️", desc: "Spread out, can't move.", role: true, edge: true },
  { id: "rope", category: "restraint", label: "Rope / shibari", emoji: "🧵", desc: "Proper tying, slow.", role: true, edge: true },
  { id: "overknee", category: "restraint", label: "Over the knee", emoji: "🦵", desc: "Bent over your lap.", role: true, edge: true },

  // 7. Roleplay & fantasy
  { id: "roleplay", category: "roleplay", label: "Roleplay a scenario", emoji: "🎭", desc: "Strangers, characters, a setup.", role: false, edge: false },
  { id: "sexting", category: "roleplay", label: "Sexting", emoji: "💬", desc: "Trade dirty pics & messages.", role: false, edge: false },
  { id: "costumes", category: "roleplay", label: "Costumes / dress-up", emoji: "👗", desc: "Outfits and personas.", role: false, edge: false },
  { id: "fantasyscene", category: "roleplay", label: "Act out a specific fantasy", emoji: "✨", desc: "That one scene you replay.", role: false, edge: false },
  { id: "forbidden", category: "roleplay", label: "\"Caught\" / forbidden vibe", emoji: "🤫", desc: "The thrill of almost-seen.", role: false, edge: false },
  { id: "pickup", category: "roleplay", label: "Strangers / pickup", emoji: "😏", desc: "Meet like total strangers.", role: false, edge: false },
  { id: "lingerie", category: "roleplay", label: "Lingerie reveal", emoji: "🩲", desc: "Dressed up to be undressed.", role: false, edge: false },
  { id: "roleplayother", category: "roleplay", label: "Roleplay you've been with someone else", emoji: "🎭", desc: "Act out the story.", role: false, edge: true },
  { id: "petplay", category: "roleplay", label: "Pet play — collar & leash", emoji: "🐾", desc: "Kitten or pup, led on a leash.", role: true, edge: true },
  { id: "rp-teacher", category: "roleplay", label: "Teacher & student", emoji: "🍎", desc: "The after-class power scene.", role: false, edge: false },
  { id: "rp-boss", category: "roleplay", label: "Boss & assistant", emoji: "💼", desc: "Office-hours power play.", role: false, edge: false },
  { id: "rp-doctor", category: "roleplay", label: "Doctor & patient", emoji: "🩺", desc: "Exam-room roleplay.", role: false, edge: false },
  { id: "rp-masseuse", category: "roleplay", label: "Masseuse & client", emoji: "💆", desc: "The \"happy ending\" scene.", role: false, edge: false },
  { id: "rp-stranger", category: "roleplay", label: "Stranger / cop stop", emoji: "🚔", desc: "Caught, talked down, taken.", role: false, edge: false },
  { id: "rp-firsttime", category: "roleplay", label: "First time / reunion", emoji: "💘", desc: "Nervous-new energy again.", role: false, edge: false },

  // 8. Toys & props
  { id: "vibrator", category: "toys", label: "Vibrator", emoji: "📳", desc: "On you or on them.", role: true, edge: false },
  { id: "newtoy", category: "toys", label: "Explore a new toy together", emoji: "🎁", desc: "Something neither's tried.", role: false, edge: false },
  { id: "lube", category: "toys", label: "Lube & sensation gels", emoji: "💧", desc: "Warming, tingling, slick.", role: false, edge: false },
  { id: "remotetoy", category: "toys", label: "Remote-control toy", emoji: "🎮", desc: "Hand over the app.", role: true, edge: false },
  { id: "cockring", category: "toys", label: "Cock ring", emoji: "💍", desc: "Harder, for longer.", role: false, edge: false },
  { id: "suctiontoy", category: "toys", label: "Clit-suction toy", emoji: "🌬️", desc: "Hands-free air-pulse buzz.", role: false, edge: false },
  { id: "wand", category: "toys", label: "Wand massager", emoji: "🪄", desc: "The heavy-duty rumble.", role: false, edge: false },
  { id: "foodplay", category: "toys", label: "Food play", emoji: "🍯", desc: "Whipped cream, ice, honey.", role: false, edge: false },
  { id: "dildo", category: "toys", label: "Dildo", emoji: "🥒", desc: "Just the shape, no buzz.", role: true, edge: false },
  { id: "impacttoy", category: "toys", label: "Paddle / crop / flogger", emoji: "🏏", desc: "A real impact tool.", role: true, edge: true },
  { id: "stroker", category: "toys", label: "Stroker / sleeve", emoji: "🧴", desc: "A toy made for him.", role: true, edge: false },
  { id: "sexpillow", category: "toys", label: "Wedge / sex pillow", emoji: "📐", desc: "Angle everything better.", role: false, edge: false },

  // 9. Watch & capture
  { id: "film", category: "watch", label: "Film yourselves", emoji: "📹", desc: "Stays in your encrypted Vault.", role: false, edge: false },
  { id: "photos", category: "watch", label: "Photos for each other", emoji: "📸", desc: "Tasteful or filthy.", role: true, edge: false },
  { id: "mirrors", category: "watch", label: "Mirrors", emoji: "🪞", desc: "Watching yourselves.", role: false, edge: false },
  { id: "watcheachother", category: "watch", label: "Watch each other", emoji: "👀", desc: "Mutual solo.", role: false, edge: false },
  { id: "lightson", category: "watch", label: "Lights on", emoji: "💡", desc: "Fully seen.", role: false, edge: false },
  { id: "watchporn", category: "watch", label: "Watch porn together", emoji: "📺", desc: "Put it on and follow along.", role: false, edge: false },
  { id: "dirtyvideo", category: "watch", label: "Dirty video / voice note", emoji: "🎙️", desc: "A clip just for them.", role: false, edge: false },
  { id: "recreatescene", category: "watch", label: "Recreate a porn scene", emoji: "🎥", desc: "Act out one you both liked.", role: false, edge: false },
  { id: "boudoir", category: "watch", label: "Boudoir shoot", emoji: "📸", desc: "A styled, filthy shoot.", role: false, edge: false },
  { id: "lapdance", category: "watch", label: "Lap dance", emoji: "💃", desc: "One performs, one sits still.", role: true, edge: false },
  { id: "cumselfie", category: "watch", label: "Selfie with cum on your face", emoji: "🤳", desc: "Snap it and send it.", role: false, edge: true },
  { id: "sendnude", category: "watch", label: "Send me a nude right now", emoji: "📱", desc: "Wherever you are.", role: false, edge: false },
  { id: "filmcumming", category: "watch", label: "Film yourself cumming", emoji: "🎥", desc: "A clip just for me.", role: false, edge: true },
  { id: "photoaftercum", category: "watch", label: "A photo right after I cum on you", emoji: "📸", desc: "Messy, kept for us.", role: false, edge: true },

  // 10. Words & care
  { id: "dirtytalk", category: "words", label: "Dirty talk", emoji: "🗣️", desc: "Who talks, who's told.", role: true, edge: false },
  { id: "praise", category: "words", label: "Praise & affirmation", emoji: "🥰", desc: "\"Good\" energy.", role: true, edge: false },
  { id: "saywhatyouwant", category: "words", label: "Say what you want out loud", emoji: "💭", desc: "Naming it in the moment.", role: false, edge: false },
  { id: "aftercare", category: "words", label: "Aftercare", emoji: "🤗", desc: "Holding, water, debrief.", role: false, edge: false },
  { id: "tellmewet", category: "words", label: "Tell me how wet you are", emoji: "💬", desc: "Out loud, in detail.", role: false, edge: false },
  { id: "tellmehard", category: "words", label: "Tell me how hard you are for me", emoji: "💬", desc: "Out loud, in detail.", role: false, edge: false },
  { id: "tellmecum", category: "words", label: "Tell me when you're about to cum", emoji: "💬", desc: "Call it out.", role: false, edge: false },
  { id: "talkmethrough", category: "words", label: "Talk me through what you're about to do", emoji: "🗣️", desc: "Narrate what's coming.", role: false, edge: false },
  { id: "breedingtalk", category: "words", label: "\"Breed me\" / \"fill you up\" talk", emoji: "🤰", desc: "The fantasy, out loud.", role: false, edge: true },
  { id: "beloud", category: "words", label: "Be loud — let me hear you", emoji: "🔊", desc: "No holding back.", role: false, edge: false },
  { id: "stayquiet", category: "words", label: "Stay quiet, don't get caught", emoji: "🤫", desc: "Silent on purpose.", role: false, edge: false },
  { id: "tellpictured", category: "words", label: "Tell me what you pictured alone", emoji: "💭", desc: "Your last solo fantasy.", role: false, edge: false },
  { id: "instructme", category: "words", label: "Tell me exactly what to do", emoji: "🗣️", desc: "Step-by-step orders, your pace.", role: true, edge: false },

  // Dirty requests — specific "do this to me" asks
  { id: "kissworkdown", category: "requests", label: "Kiss me, then work your way down", emoji: "💋", desc: "Lips down your body.", role: false, edge: false },
  { id: "lookupblow", category: "requests", label: "Look up at me while you blow me", emoji: "👀", desc: "Eyes on me the whole time.", role: false, edge: false },
  { id: "strokeandsuck", category: "requests", label: "Stroke and suck at the same time", emoji: "🤤", desc: "Mouth and hand together.", role: false, edge: false },
  { id: "playwhileblow", category: "requests", label: "Play with yourself while you blow me", emoji: "🫦", desc: "Turned on while you do it.", role: false, edge: false },
  { id: "spitonit", category: "requests", label: "Spit on it", emoji: "💦", desc: "Messy and wet.", role: false, edge: false },
  { id: "kissinside", category: "requests", label: "Kiss me while you're inside me", emoji: "💞", desc: "Mouths together, deep.", role: false, edge: false },
  { id: "clitwhilefuck", category: "requests", label: "Rub my clit while you fuck me", emoji: "👆", desc: "Fingers and hips at once.", role: false, edge: false },
  { id: "dirtytalkfuck", category: "requests", label: "Talk dirty in my ear while you fuck me", emoji: "🗣️", desc: "Filth in my ear.", role: false, edge: false },
  { id: "slowdeepkiss", category: "requests", label: "Slow and deep while we make out", emoji: "🐢", desc: "Unhurried, mouths locked.", role: false, edge: false },
  { id: "biteneckgrind", category: "requests", label: "Bite my neck while you grind into me", emoji: "🦷", desc: "Teeth on my neck.", role: false, edge: false },
  { id: "slapassride", category: "requests", label: "Slap my ass while I ride you", emoji: "🍑", desc: "A sharp sting on top.", role: false, edge: true },
  { id: "handthroatfuck", category: "requests", label: "A hand on my throat while you fuck me", emoji: "🤏", desc: "Held just right.", role: false, edge: true },
  { id: "cuminmouthshow", category: "requests", label: "Cum in my mouth and make me show you", emoji: "👅", desc: "Hold it, then open up.", role: false, edge: true },
  { id: "keepgoingafter", category: "requests", label: "Keep going even after you cum in me", emoji: "🔁", desc: "Don't stop after.", role: false, edge: true },
  { id: "postvideos", category: "requests", label: "Post our videos online", emoji: "📲", desc: "Out there for strangers.", role: false, edge: true },
  { id: "praisemycock", category: "requests", label: "While you blow me, tell me how much you love my cock", emoji: "🗣️", desc: "Praise mid-blowjob.", role: true, edge: false },
  { id: "tellgoodtaste", category: "requests", label: "While you eat me out, tell me how good I taste", emoji: "🗣️", desc: "Words while you go down.", role: true, edge: false },

  // 11. Finish & cum play
  { id: "facial", category: "cumplay", label: "Facial", emoji: "💦", desc: "Finish on the face.", role: true, edge: true },
  { id: "cumonbody", category: "cumplay", label: "Cum on me, wherever I want it", emoji: "💦", desc: "Tits, ass, chest, back — your call.", role: true, edge: true },
  { id: "cuminmouth", category: "cumplay", label: "Cum in mouth / swallow", emoji: "👄", desc: "Finish in the mouth.", role: true, edge: true },
  { id: "creampie", category: "cumplay", label: "Creampie", emoji: "🍯", desc: "Finishing inside.", role: true, edge: true },
  { id: "cumplay", category: "cumplay", label: "Cum play", emoji: "💧", desc: "Messing with it after.", role: false, edge: true },
  { id: "finishtogether", category: "cumplay", label: "Finish together", emoji: "🎆", desc: "Timed to cum at once.", role: false, edge: false },
  { id: "roundtwo", category: "cumplay", label: "Round two", emoji: "🔁", desc: "Go again, right after.", role: false, edge: false },
  { id: "hercumfirst", category: "cumplay", label: "Make her cum first", emoji: "💦", desc: "Her orgasm before yours.", role: true, edge: false },
  { id: "hercummore", category: "cumplay", label: "Make her cum more than once", emoji: "💦", desc: "Don't stop at one.", role: true, edge: false },
  { id: "overstimher", category: "cumplay", label: "Overstimulate her — past the edge", emoji: "💥", desc: "Past the first, still going.", role: true, edge: true },
  { id: "ruinedorgasm", category: "cumplay", label: "Ruined orgasm", emoji: "🚫", desc: "Pushed over, then stopped cold.", role: true, edge: true },

  // 12. Anal
  { id: "analsex", category: "anal", label: "Anal sex", emoji: "🍑", desc: "Giving or receiving.", role: true, edge: true },
  { id: "rimming", category: "anal", label: "Rimming", emoji: "👅", desc: "Oral-anal.", role: true, edge: true },
  { id: "analfingering", category: "anal", label: "Anal fingering", emoji: "🫳", desc: "Fingers, gently.", role: true, edge: true },
  { id: "buttplug", category: "anal", label: "Butt plug / anal toys", emoji: "🔌", desc: "Plugs and beads.", role: true, edge: true },
  { id: "pegging", category: "anal", label: "Pegging", emoji: "🍆", desc: "Strap-on.", role: true, edge: true },
  { id: "prostate", category: "anal", label: "Prostate massage", emoji: "👆", desc: "The P-spot, from inside.", role: true, edge: true },
  { id: "analtraining", category: "anal", label: "Work up to it slowly", emoji: "📈", desc: "Anal training, over time.", role: true, edge: true },

  // 13. Opening up
  { id: "threesome-mfm", category: "others", label: "Threesome — MFM", emoji: "3️⃣", desc: "Two men, one woman.", role: false, edge: true },
  { id: "threesome-ffm", category: "others", label: "Threesome — FFM", emoji: "3️⃣", desc: "Two women, one man.", role: false, edge: true },
  { id: "group", category: "others", label: "Group / foursome", emoji: "👥", desc: "More than three.", role: false, edge: true },
  { id: "swap", category: "others", label: "Swap with another couple", emoji: "🔄", desc: "Swinging.", role: false, edge: true },
  { id: "watchpartner", category: "others", label: "Watch your partner with someone", emoji: "👁️", desc: "Watching your partner with someone else.", role: true, edge: true },
  { id: "softswap", category: "others", label: "Soft swap", emoji: "🤝", desc: "Play, no full sex.", role: false, edge: true },
  { id: "fantasyonly", category: "others", label: "Just the fantasy", emoji: "💭", desc: "Talk about it, never act on it.", role: false, edge: true },
  { id: "fantasyother", category: "others", label: "I want you to tell me about your hottest fantasy with someone else", emoji: "💭", desc: "Out loud, just the fantasy.", role: false, edge: true },
  { id: "imaginemeother", category: "others", label: "Imagine me with someone else, out loud", emoji: "💭", desc: "Say the fantasy aloud.", role: false, edge: true },
  { id: "lifestyleclub", category: "others", label: "A lifestyle club / party", emoji: "🎉", desc: "Go together, see the scene.", role: false, edge: true },

  // 14. Heavier kink
  { id: "degradation", category: "heavier", label: "Degradation / dirty names", emoji: "😈", desc: "Talked down to, hot.", role: true, edge: true },
  { id: "humiliation", category: "heavier", label: "Humiliation play", emoji: "🥵", desc: "Embarrassment as a turn-on.", role: true, edge: true },
  { id: "deepthroat", category: "heavier", label: "Deepthroat / gagging", emoji: "😮", desc: "Deeper oral.", role: true, edge: true },
  { id: "spitting", category: "heavier", label: "Spitting", emoji: "💧", desc: "On request.", role: true, edge: true },
  { id: "squirting", category: "heavier", label: "Squirting", emoji: "💦", desc: "Going for it.", role: false, edge: true },
  { id: "doublepen", category: "heavier", label: "Double penetration", emoji: "✌️", desc: "Two at once.", role: true, edge: true },
  { id: "fisting", category: "heavier", label: "Fisting", emoji: "✊", desc: "Slow, lots of prep.", role: true, edge: true },
  { id: "watersports", category: "heavier", label: "Watersports (golden shower)", emoji: "💛", desc: "Edge play; only if you're both into it.", role: true, edge: true },
  { id: "feminization", category: "heavier", label: "Feminization / sissy play", emoji: "💄", desc: "Dressed up and played as the other.", role: true, edge: true },
];

export const QUIZ_CARD_BY_ID: Record<string, QuizCard> = Object.fromEntries(
  QUIZ_DECK.map((card) => [card.id, card]),
);

export function categoryTitle(id: string): string {
  return QUIZ_CATEGORIES.find((c) => c.id === id)?.title || "";
}

// One-tap "propose this": deep-link to the Ask composer pre-noted with a card, so
// a quiz match / curious item turns straight into an Ask. Shared by the quiz
// reveal and the Sexboard "what you're both into" strip.
export function proposeHref(label: string): string {
  return `/ask?note=${encodeURIComponent(`From our Sex Quiz: ${label}`)}`;
}
