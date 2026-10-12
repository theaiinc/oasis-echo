import os, sys, subprocess, random
sys.path.insert(0, os.path.dirname(__file__)); from texts import *
OUT="/Volumes/Data/dev/wakeword-arion/tts"
EN=["Aman","Daniel","Eddy (English (UK))","Eddy (English (US))","Flo (English (UK))","Flo (English (US))","Fred",
    "Grandma (English (US))","Grandpa (English (UK))","Karen","Kathy","Moira","Ralph","Reed (English (US))","Rishi",
    "Rocko (English (UK))","Samantha","Sandy (English (US))","Shelley (English (UK))","Tara","Tessa"]
r=random.Random(2)
def say(text, voice, rate, rel):
    p=os.path.join(OUT,rel)
    if os.path.exists(p): return
    os.makedirs(os.path.dirname(p),exist_ok=True)
    aiff=p[:-4]+".aiff"
    subprocess.run(["say","-v",voice,"-r",str(rate),"-o",aiff,text],capture_output=True)
    subprocess.run(["ffmpeg","-y","-loglevel","error","-i",aiff,"-ar","16000","-ac","1",p])
    os.remove(aiff)
def slug(v): return v.split(" ")[0]+("UK" if "UK" in v else "")
for v in EN:
    i=0
    for t in EN_POS_HEY:
        for rate in (150,185,220):
            say(t,v,rate,f"pos_hey/say_{slug(v)}_{i:03d}.wav"); i+=1
    i=0
    for t in EN_CONFUSABLE+r.sample(EN_SPEECH,10):
        say(t,v,r.choice((160,190,220)),f"neg/say_{slug(v)}_{i:03d}.wav"); i+=1
i=0
for t in VI_POS_ARION:
    for rate in (140,170,200,230):
        say(t,"Linh",rate,f"pos_arion/say_Linh_{i:03d}.wav"); i+=1
i=0
for t in VI_POS_HEY:
    for rate in (150,200):
        say(t,"Linh",rate,f"pos_hey/say_Linh_{i:03d}.wav"); i+=1
i=0
for t in VI_CONFUSABLE+VI_SPEECH:
    say(t,"Linh",r.choice((150,180,210)),f"neg/say_Linh_{i:03d}.wav"); i+=1
print("SAY DONE")
