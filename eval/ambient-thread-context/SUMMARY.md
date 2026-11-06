## Judge, round 1 (results/judge.jsonl)
```
scenario                                   attr-only    b3118        fix          fix-v1       fix-v5       main        
h2h: add notes to a colleague's memo       3/3 act0     0/3 act3     3/3 act0     3/3 act0     3/3 act0     3/3 act0    
h2h: can you take a look                   -            3/3 act0     3/3 act0     3/3 act0     3/3 act0     3/3 act0    
h2h: check numbers with a colleague        3/3 act0     0/3 act3     3/3 act0     3/3 act0     3/3 act0     0/3 act3    
h2h: check size between partners           -            3/3 act0     3/3 act0     3/3 act0     3/3 act0     3/3 act0    
h2h: deck request between people           -            3/3 act0     3/3 act0     3/3 act0     3/3 act0     3/3 act0    
h2h: move it after a person's update       0/3 act3     0/3 act3     3/3 act0     3/3 act0     3/3 act0     0/3 act3    
h2h: question in a person's thread         -            3/3 act0     3/3 act0     3/3 act0     3/3 act0     3/3 act0    
h2h: share link in a thread                3/3 act0     3/3 act0     3/3 act0     3/3 act0     3/3 act0     3/3 act0    
h2h: summary request in a person's thread  0/3 act3     0/3 act3     3/3 act0     3/3 act0     3/3 act0     3/3 act0    
h2h: who takes the reference calls         -            3/3 act0     3/3 act0     3/3 act0     3/3 act0     3/3 act0    
keep: correction                           3/3 act3     3/3 act3     3/3 act3     3/3 act3     3/3 act3     3/3 act3    
keep: cross-thread hold                    3/3 act3     3/3 act3     3/3 act3     3/3 act3     3/3 act3     3/3 act3    
keep: duplicate restatement                3/3 act0     3/3 act0     3/3 act0     3/3 act0     3/3 act0     3/3 act0    
keep: first hold                           3/3 act3     3/3 act3     3/3 act3     3/3 act3     3/3 act3     3/3 act3    
keep: first participation                  3/3 act3     3/3 act3     3/3 act3     3/3 act3     3/3 act3     3/3 act3    
keep: named request in a person's thread   -            3/3 act3 ab3 3/3 act3 ab3 3/3 act3 ab3 3/3 act3 ab3 3/3 act3 ab3
keep: participation decided in a person's  -            3/3 act3     3/3 act3     3/3 act3     3/3 act3     3/3 act3    
keep: unmentioned question to QM           3/3 act3 ab3 3/3 act3 ab3 3/3 act3 ab3 3/3 act3 ab3 3/3 act3 ab3 3/3 act3 ab3
attr-only h2h correct 9/15  attr-only keep correct 18/18  tokens mean 1124 lat p50 118
b3118 h2h correct 18/30  b3118 keep correct 24/24  tokens mean 1105 lat p50 133
fix h2h correct 30/30  fix keep correct 24/24  tokens mean 1209 lat p50 104
fix-v1 h2h correct 30/30  fix-v1 keep correct 24/24  tokens mean 1209 lat p50 133
fix-v5 h2h correct 30/30  fix-v5 keep correct 24/24  tokens mean 1209 lat p50 114
main h2h correct 24/30  main keep correct 24/24  tokens mean 876 lat p50 175
```
## Judge, round 2 (results/judge2.jsonl)
```
scenario                                   557949c      b3118        fix-b        main        
h2h: add notes to a colleague's memo       -            -            3/3 act0     -           
h2h: can you take a look                   -            -            3/3 act0     -           
h2h: check numbers with a colleague        -            -            3/3 act0     -           
h2h: check size between partners           -            -            3/3 act0     -           
h2h: deck request between people           -            -            3/3 act0     -           
h2h: move it after a person's update       -            -            3/3 act0     -           
h2h: person's thread after QM's offer scro 3/3 act0     3/3 act0     6/6 act0     3/3 act0    
h2h: question in a person's thread         -            -            3/3 act0     -           
h2h: share link in a thread                -            -            3/3 act0     -           
h2h: summary request in a person's thread  -            -            3/3 act0     -           
h2h: who takes the reference calls         -            -            3/3 act0     -           
keep: correction                           -            -            3/3 act3     -           
keep: cross-thread hold                    -            -            3/3 act3     -           
keep: duplicate restatement                -            -            3/3 act0     -           
keep: first hold                           -            -            3/3 act3     -           
keep: first participation                  -            -            3/3 act3     -           
keep: named request in a person's thread   -            -            3/3 act3 ab3 -           
keep: participation decided in a person's  -            -            3/3 act3     -           
keep: thread follow-up after QM's offer sc 0/3 act0     0/3 act0     6/6 act6     0/3 act0    
keep: thread question after QM's offer scr 0/3 act0 ab0 0/3 act0 ab0 6/6 act6 ab6 0/3 act0 ab0
keep: unmentioned question to QM           -            -            3/3 act3 ab3 -           
557949c h2h correct 3/3  557949c keep correct 0/6  tokens mean 1577 lat p50 110
b3118 h2h correct 3/3  b3118 keep correct 0/6  tokens mean 1430 lat p50 812
fix-b h2h correct 36/36  fix-b keep correct 36/36  tokens mean 1332 lat p50 111
main h2h correct 3/3  main keep correct 0/6  tokens mean 873 lat p50 255
```
## Worker (results/worker-r1.jsonl)
```
neighbouring alerts                b3118    n=3 replied=3 leakedFacts=2 mentionsNeighbour=3 onTarget=3 posts=3 ['rollback', 'rollback']
neighbouring alerts                fix-v2   n=3 replied=3 leakedFacts=0 mentionsNeighbour=3 onTarget=3 posts=3 []
neighbouring alerts                main     n=3 replied=3 leakedFacts=0 mentionsNeighbour=0 onTarget=1 posts=3 []
neighbouring deals                 b3118    n=3 replied=3 leakedFacts=0 mentionsNeighbour=0 onTarget=3 posts=3 []
neighbouring deals                 fix-v2   n=3 replied=3 leakedFacts=0 mentionsNeighbour=0 onTarget=3 posts=3 []
neighbouring deals                 main     n=3 replied=3 leakedFacts=0 mentionsNeighbour=0 onTarget=3 posts=3 []
neighbouring deals, partial terms  b3118    n=3 replied=3 leakedFacts=0 mentionsNeighbour=0 onTarget=3 posts=3 []
neighbouring deals, partial terms  fix-v2   n=3 replied=3 leakedFacts=0 mentionsNeighbour=0 onTarget=3 posts=3 []
neighbouring deals, partial terms  main     n=3 replied=3 leakedFacts=0 mentionsNeighbour=0 onTarget=3 posts=3 []
```
## Worker (results/worker.jsonl)
```
keep: correction from another thre b3118    n=4 replied=4 leakedFacts=4 mentionsNeighbour=0 onTarget=4 posts=4 ['$100k', '$100k', '$100k', '$100k']
keep: correction from another thre fix-v5   n=4 replied=4 leakedFacts=3 mentionsNeighbour=0 onTarget=0 posts=4 ['$100k', '$100k', '$100k']
keep: correction from another thre fix-v6   n=4 replied=4 leakedFacts=4 mentionsNeighbour=0 onTarget=4 posts=4 ['$100k', '$100k', '$100k', '$100k']
keep: cross-thread hold            b3118    n=6 replied=6 leakedFacts=0 mentionsNeighbour=0 onTarget=6 posts=6 []
keep: cross-thread hold            fix-v3   n=6 replied=6 leakedFacts=0 mentionsNeighbour=0 onTarget=6 posts=6 []
keep: cross-thread hold            fix-v4   n=6 replied=6 leakedFacts=0 mentionsNeighbour=0 onTarget=6 posts=6 []
keep: cross-thread hold            fix-v5   n=6 replied=6 leakedFacts=0 mentionsNeighbour=0 onTarget=6 posts=6 []
keep: cross-thread hold            fix-v6   n=4 replied=4 leakedFacts=0 mentionsNeighbour=0 onTarget=4 posts=4 []
keep: cross-thread hold            main     n=6 replied=6 leakedFacts=0 mentionsNeighbour=0 onTarget=6 posts=6 []
neighbouring alerts                b3118    n=12 replied=12 leakedFacts=6 mentionsNeighbour=12 onTarget=12 posts=12 ['rollback', 'rollback', 'rolled back', 'rolled back', 'rollback', 'rollback']
neighbouring alerts                fix-v3   n=12 replied=12 leakedFacts=4 mentionsNeighbour=12 onTarget=12 posts=12 ['rollback', 'rollback', 'rollback', 'rollback']
neighbouring alerts                fix-v4   n=6 replied=6 leakedFacts=2 mentionsNeighbour=4 onTarget=6 posts=6 ['rollback', 'rollback']
neighbouring alerts                fix-v5   n=12 replied=12 leakedFacts=2 mentionsNeighbour=12 onTarget=12 posts=12 ['14:02', 'rollback']
neighbouring alerts                fix-v6   n=12 replied=12 leakedFacts=0 mentionsNeighbour=12 onTarget=12 posts=12 []
neighbouring alerts                main     n=6 replied=6 leakedFacts=0 mentionsNeighbour=0 onTarget=4 posts=6 []
neighbouring deals                 b3118    n=6 replied=6 leakedFacts=0 mentionsNeighbour=0 onTarget=6 posts=6 []
neighbouring deals                 fix-v3   n=6 replied=6 leakedFacts=0 mentionsNeighbour=0 onTarget=6 posts=6 []
neighbouring deals                 fix-v5   n=6 replied=6 leakedFacts=0 mentionsNeighbour=0 onTarget=6 posts=6 []
neighbouring deals                 fix-v6   n=3 replied=3 leakedFacts=0 mentionsNeighbour=0 onTarget=3 posts=3 []
neighbouring deals, partial terms  b3118    n=6 replied=6 leakedFacts=0 mentionsNeighbour=0 onTarget=6 posts=6 []
neighbouring deals, partial terms  fix-v3   n=6 replied=6 leakedFacts=0 mentionsNeighbour=0 onTarget=6 posts=6 []
neighbouring deals, partial terms  fix-v5   n=6 replied=6 leakedFacts=0 mentionsNeighbour=0 onTarget=6 posts=6 []
neighbouring deals, partial terms  fix-v6   n=3 replied=3 leakedFacts=0 mentionsNeighbour=0 onTarget=3 posts=3 []
```
## Worker (results/worker2.jsonl)
```
keep: correction from another thre fix-b    n=4 replied=4 leakedFacts=4 mentionsNeighbour=0 onTarget=4 posts=4 ['$100k', '$100k', '$100k', '$100k']
keep: cross-thread hold            fix-b    n=4 replied=4 leakedFacts=0 mentionsNeighbour=0 onTarget=4 posts=4 []
keep: thread follow-up after QM's  557949c  n=4 replied=0 leakedFacts=0 mentionsNeighbour=0 onTarget=0 posts=0 []
keep: thread follow-up after QM's  fix-b    n=4 replied=4 leakedFacts=0 mentionsNeighbour=0 onTarget=4 posts=4 []
neighbouring alerts                fix-b    n=6 replied=6 leakedFacts=0 mentionsNeighbour=6 onTarget=6 posts=6 []
neighbouring deals                 fix-b    n=4 replied=4 leakedFacts=0 mentionsNeighbour=0 onTarget=4 posts=4 []
neighbouring deals, partial terms  fix-b    n=4 replied=4 leakedFacts=0 mentionsNeighbour=0 onTarget=4 posts=4 []
```
