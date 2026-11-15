/** Executed inside the guest. Directory fds plus O_NOFOLLOW pin every path component, including the root. */
export const CUA_LIBRARY_PROGRAM = String.raw`import os,sys,stat,json,base64,re
mode,base,bot,relative=sys.argv[1:]
if mode not in ('list','read') or not base.startswith('/') or not re.fullmatch(r'bot_[A-Za-z0-9_-]{1,120}',bot): raise ValueError('invalid library request')
parts=relative.split('/') if relative else []
if any(p in ('','.','..') or any(c in p for c in '\x00\r\n') for p in parts): raise ValueError('invalid path')
if mode=='read' and not parts: raise ValueError('missing file')
baseparts=base.strip('/').split('/')
if any(p in ('','.','..') for p in baseparts): raise ValueError('invalid root')
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
fd=os.open('/',flags)
try:
    dirs=baseparts+[bot]+(parts if mode=='list' else parts[:-1])
    for i,part in enumerate(dirs):
        if mode=='list' and i in (len(baseparts)-2,len(baseparts)-1,len(baseparts)):
            try: os.mkdir(part,mode=0o700,dir_fd=fd)
            except FileExistsError: pass
        expected=os.stat(part,dir_fd=fd,follow_symlinks=False)
        if not stat.S_ISDIR(expected.st_mode): raise ValueError('library component is not a directory')
        nextfd=os.open(part,flags,dir_fd=fd)
        actual=os.fstat(nextfd)
        if not stat.S_ISDIR(actual.st_mode) or (actual.st_dev,actual.st_ino)!=(expected.st_dev,expected.st_ino):
            os.close(nextfd)
            raise ValueError('library directory changed while opening')
        os.close(fd)
        fd=nextfd
    if mode=='list':
        files=[]
        for name in os.listdir(fd)[:5000]:
            try: s=os.stat(name,dir_fd=fd,follow_symlinks=False)
            except FileNotFoundError: continue
            if stat.S_ISLNK(s.st_mode): continue
            if not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode)): continue
            files.append(dict(name=name,size=s.st_size,modifiedAt=int(s.st_mtime*1000),isDir=stat.S_ISDIR(s.st_mode)))
        print(json.dumps(sorted(files,key=lambda x:(not x['isDir'],-x['modifiedAt']))))
    else:
        expected=os.stat(parts[-1],dir_fd=fd,follow_symlinks=False)
        if not stat.S_ISREG(expected.st_mode) or expected.st_nlink!=1: raise ValueError('not a regular library file')
        f=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
        with os.fdopen(f,'rb') as stream:
            s=os.fstat(stream.fileno())
            if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size>8*1024*1024 or (s.st_dev,s.st_ino)!=(expected.st_dev,expected.st_ino): raise ValueError('not the bounded regular file that was checked')
            data=stream.read(8*1024*1024+1)
            if len(data)>8*1024*1024: raise ValueError('file too large')
        print(base64.b64encode(data).decode('ascii'))
finally:
    os.close(fd)
`;
