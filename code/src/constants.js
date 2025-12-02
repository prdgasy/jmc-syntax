// src/constants.js

const jmcKeywords = [
    "class", "function", "if", "else", "for", "while",
    "return", "import", "new", "switch", "case", "default",
    "do", "break", "continue"
];

const functionExceptionList = ['if', 'while', 'for', 'switch'];

const nbtTypes = {
    string: "NBTString",
    integer: "NBTInt",
    float: "NBTFloat",
    byte: "NBTByte", // Pour true/false souvent
    compound: "NBTCompound",
    list: "NBTList",
    long: "NBTLong",
    double: "NBTDouble"
};

// Documentation complète des commandes Minecraft (1.21+)
const mcCommandDocs = {
    "advancement": { syntax: "advancement (grant|revoke) <targets> ...", description: "Grants or revokes advancements from players." },
    "attribute": { syntax: "attribute <target> <attribute> (get|base|modifier) ...", description: "Queries, adds, removes or sets entity attributes." },
    "ban": { syntax: "ban <targets> [<reason>]", description: "Adds player(s) to the blacklist." },
    "ban-ip": { syntax: "ban-ip <target> [<reason>]", description: "Adds IP address(es) to the blacklist." },
    "banlist": { syntax: "banlist [ips|players]", description: "Displays the banlist." },
    "bossbar": { syntax: "bossbar (add|get|list|remove|set) ...", description: "Creates and modifies bossbars." },
    "clear": { syntax: "clear [<targets>] [<item>] [<maxCount>]", description: "Clears items from player inventory." },
    "clone": { syntax: "clone <begin> <end> <destination> ...", description: "Copies blocks from one place to another." },
    "damage": { syntax: "damage <target> <amount> [<damageType>] ...", description: "Inflicts damage to entities." },
    "data": { syntax: "data (get|merge|modify|remove) ...", description: "Gets, merges, modifies, or removes entity/block NBT data." },
    "datapack": { syntax: "datapack (disable|enable|list) ...", description: "Controls loaded data packs." },
    "debug": { syntax: "debug (start|stop|function)", description: "Starts or stops a debugging session." },
    "defaultgamemode": { syntax: "defaultgamemode <mode>", description: "Sets the default game mode for new players." },
    "deop": { syntax: "deop <targets>", description: "Revokes operator status from players." },
    "difficulty": { syntax: "difficulty <difficulty>", description: "Sets the difficulty level." },
    "effect": { syntax: "effect (clear|give) ...", description: "Add or remove status effects." },
    "enchant": { syntax: "enchant <targets> <enchantment> [<level>]", description: "Adds an enchantment to a player's selected item." },
    "execute": { syntax: "execute (as|at|if|unless|run|...) ...", description: "Executes another command." },
    "experience": { syntax: "experience (add|query|set) ...", description: "Gives or removes player experience." },
    "fill": { syntax: "fill <from> <to> <block> ...", description: "Fills a region with a specific block." },
    "fillbiome": { syntax: "fillbiome <from> <to> <biome> ...", description: "Changes the biome of an area." },
    "forceload": { syntax: "forceload (add|query|remove) ...", description: "Toggles force-loading of chunks." },
    "function": { syntax: "function <name> [arguments]", description: "Runs a function." },
    "gamemode": { syntax: "gamemode <mode> [<target>]", description: "Sets a player's game mode." },
    "gamerule": { syntax: "gamerule <rule> [<value>]", description: "Sets or queries a game rule value." },
    "give": { syntax: "give <targets> <item> [<amount>]", description: "Gives an item to a player." },
    "help": { syntax: "help [<command>]", description: "Provides help for commands." },
    "item": { syntax: "item (modify|replace) ...", description: "Manipulates items in inventories or blocks." },
    "jfr": { syntax: "jfr (start|stop)", description: "Starts or stops JFR profiling." },
    "kick": { syntax: "kick <targets> [<reason>]", description: "Kicks a player from the server." },
    "kill": { syntax: "kill [<targets>]", description: "Kills entities (including players)." },
    "list": { syntax: "list [uuids]", description: "Lists players on the server." },
    "locate": { syntax: "locate (structure|biome|poi) ...", description: "Locates the nearest structure, biome, or POI." },
    "loot": { syntax: "loot (spawn|replace|give|insert) ...", description: "Drops items from loot tables into inventory or world." },
    "me": { syntax: "me <action>", description: "Displays a message about yourself." },
    "msg": { syntax: "msg <targets> <message>", description: "Sends a private message to one or more players." },
    "op": { syntax: "op <targets>", description: "Grants operator status to a player." },
    "pardon": { syntax: "pardon <targets>", description: "Removes entries from the blacklist." },
    "pardon-ip": { syntax: "pardon-ip <target>", description: "Removes IP entries from the blacklist." },
    "particle": { syntax: "particle <name> [<pos>] ...", description: "Creates particles." },
    "perf": { syntax: "perf (start|stop)", description: "Captures profiling data." },
    "place": { syntax: "place (feature|jigsaw|structure|template) ...", description: "Places a configured feature, structure, etc." },
    "playsound": { syntax: "playsound <sound> <source> <targets> ...", description: "Plays a sound." },
    "publish": { syntax: "publish [<port>]", description: "Opens single-player world to LAN." },
    "random": { syntax: "random (value|roll) ...", description: "Generates random values or checks." },
    "recipe": { syntax: "recipe (give|take) ...", description: "Gives or takes player recipes." },
    "reload": { syntax: "reload", description: "Reloads data packs." },
    "return": { syntax: "return <value>", description: "Controls return values in functions." },
    "ride": { syntax: "ride <target> (mount|dismount) ...", description: "Makes entities ride other entities." },
    "rotate": { syntax: "rotate <target> <rotation>", description: "Rotates an entity." },
    "save-all": { syntax: "save-all [flush]", description: "Saves the server to disk." },
    "save-off": { syntax: "save-off", description: "Disables automatic server saving." },
    "save-on": { syntax: "save-on", description: "Enables automatic server saving." },
    "say": { syntax: "say <message>", description: "Displays a message to multiple players." },
    "schedule": { syntax: "schedule (function|clear) ...", description: "Delays the execution of a function." },
    "scoreboard": { syntax: "scoreboard (objectives|players) ...", description: "Manages scoreboard objectives and players." },
    "seed": { syntax: "seed", description: "Displays the world seed." },
    "setblock": { syntax: "setblock <pos> <block> ...", description: "Changes a block." },
    "setidletimeout": { syntax: "setidletimeout <minutes>", description: "Sets the time before idle players are kicked." },
    "setworldspawn": { syntax: "setworldspawn [<pos>] [<angle>]", description: "Sets the world spawn." },
    "spawnpoint": { syntax: "spawnpoint [<targets>] [<pos>] [<angle>]", description: "Sets the spawn point for a player." },
    "spectate": { syntax: "spectate [<target>] [<player>]", description: "Makes a player spectate an entity." },
    "spreadplayers": { syntax: "spreadplayers <center> <spreadDistance> ...", description: "Teleports entities to random locations." },
    "stop": { syntax: "stop", description: "Stops the server." },
    "stopsound": { syntax: "stopsound <targets> [<source>] [<sound>]", description: "Stops a sound." },
    "summon": { syntax: "summon <entity> [<pos>] [<nbt>]", description: "Summons an entity." },
    "tag": { syntax: "tag <targets> (add|remove|list) ...", description: "Controls entity tags." },
    "team": { syntax: "team (add|empty|join|leave|list|modify|remove) ...", description: "Modifies teams." },
    "teammsg": { syntax: "teammsg <message>", description: "Sends a message to all players on your team." },
    "teleport": { syntax: "teleport <targets> <location>", description: "Teleports entities." },
    "tell": { syntax: "tell <targets> <message>", description: "Sends a private message." },
    "tellraw": { syntax: "tellraw <targets> <message>", description: "Displays a JSON message to players." },
    "tick": { syntax: "tick (query|rate|step|sprint|freeze|unfreeze) ...", description: "Controls the server tick flow." },
    "time": { syntax: "time (add|query|set) <value>", description: "Changes or queries the world's game time." },
    "title": { syntax: "title <targets> (clear|reset|title|subtitle|actionbar|times) ...", description: "Manages screen titles." },
    "tm": { syntax: "tm <message>", description: "Sends a team message (Alias of teammsg)." },
    "tp": { syntax: "tp <targets> <location>", description: "Teleports entities (Alias of teleport)." },
    "transfer": { syntax: "transfer <hostname> [<port>]", description: "Transfers players to another server." },
    "trigger": { syntax: "trigger <objective> [add|set]", description: "Sets a trigger to be activated." },
    "w": { syntax: "w <targets> <message>", description: "Sends a private message (Alias of msg)." },
    "weather": { syntax: "weather (clear|rain|thunder) [<duration>]", description: "Sets the weather." },
    "whitelist": { syntax: "whitelist (add|list|off|on|reload|remove)", description: "Manages the server whitelist." },
    "worldborder": { syntax: "worldborder (add|center|damage|get|set|warning) ...", description: "Manages the world border." },
    "xp": { syntax: "xp (add|query|set) ...", description: "Manages experience (Alias of experience)." }
};

// Liste simple des noms de commandes pour la validation
const mcCommands = Object.keys(mcCommandDocs);

module.exports = {
    jmcKeywords,
    functionExceptionList,
    mcCommands,
    mcCommandDocs
};