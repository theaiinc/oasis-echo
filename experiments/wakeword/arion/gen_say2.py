import os, sys
sys.path.insert(0, os.path.dirname(__file__)); from texts import *; import subprocess
exec(open(os.path.join(os.path.dirname(__file__),'gen_say.py')).read().split('for v in EN:')[0])
for v in EN:
    i = 0
    for t in EN_POS_WORD:
        for rate in (150, 190, 230): say(t, v, rate, f"pos_word/say_{slug(v)}_{i:03d}.wav"); i += 1
    i = 0
    for t in EN_POS_RION:
        for rate in (190, 240): say(t, v, rate, f"pos_rion/say_{slug(v)}_{i:03d}.wav"); i += 1
i = 0
for t in VI_POS_WORD:
    for rate in (150, 190, 230): say(t, "Linh", rate, f"pos_word/say_Linh_{i:03d}.wav"); i += 1
i = 0
for t in VI_POS_RION:
    for rate in (180, 230): say(t, "Linh", rate, f"pos_rion/say_Linh_{i:03d}.wav"); i += 1
for i, t in enumerate(VI_LOOKALIKE): say(t, "Linh", 190, f"lookalike/say_Linh_{i:03d}.wav")
for v in EN:
    for i, t in enumerate(EN_POS_RYAN):
        say(t, v, (170, 210)[i % 2], f"pos_ryan/say_{slug(v)}_{i:03d}.wav")
    for i, t in enumerate(EN_LOOKALIKE):
        say(t, v, 190, f"lookalike/say_{slug(v)}_{i:03d}.wav")
for i, t in enumerate(VI_POS_RYAN): say(t, "Linh", 190, f"pos_ryan/say_Linh_{i:03d}.wav")
print("SAY2 DONE")
