const arch = Process.arch;
let breakpoint_ins = null; //不同架构不同的软断点hex 要小写
let writer = null;
// const break_mem = Memory.alloc(4);
// const memcpy_addr = Module.findExportByName('libc.so', 'memcpy');
// const memcpy = new NativeFunction(memcpy_addr, 'pointer', ['pointer', 'pointer', 'int']);

(_=>{
    switch (arch) {
        case "arm64":
            breakpoint_ins = '000020d4'
            writer = Arm64Writer
            // break_mem.writeByteArray(hex2buf(breakpoint_ins))
            break
        default:
            console.error(arch,' not support')
    }
})()

function buf2hex(buffer) { // buffer is an ArrayBuffer
    return Array.prototype.map.call(new Uint8Array(buffer), x => ('00' + x.toString(16)).slice(-2)).join('');
}
function hex2buf(hex){
    return  new Uint8Array(hex.match(/[\da-f]{2}/gi).map(function (h) {return parseInt(h, 16)})).buffer
}


/**
 * @param pc_addr 目标断点
 * @returns {boolean} 返回真是断点，返回假不是断点
 */
function checkbreakpoint(pc_addr){
    return buf2hex(rpc.exports.readdata(pc_addr,4)) === breakpoint_ins
}
/**
 * 通过不同的writer来写不同的断点
 * 原理是先恢复内存保护然后设置软断点
 * 自己的断点被访问后，恢复断点，设置内存保护
 * cmd 1
 *
 * @param break_info 断点信息
 * @param writer 不同的writer
 * @returns {boolean} 返回真假 真表示处理 假表示异常未处理
 */
function resume_pagebreak_write_softbreakpoint(break_info,writer){

    let pc_addr = ptr(break_info['current_pc']);
    const break_page_info = break_info['break_page_info'];
    //获取当前指令长度
    const size = Instruction.parse(pc_addr).size;
    //恢复原始的内存保护
    rpc.exports.setpageprotect(break_page_info[0],break_page_info[1])
    //把要写的断点移到下个条指令
    pc_addr = pc_addr.add(size)
    const ins_writer = new writer(pc_addr);
    const store_size = Instruction.parse(pc_addr).size;


    //保存断点消息
    let send_dict = {};
    send_dict['break_addr'] = pc_addr
    send_dict['break_len'] = store_size
    send_dict['ins_content'] = buf2hex(rpc.exports.readdata(pc_addr,store_size))
    send_dict['__tag'] = 'set_soft_breakpoint'
    send(send_dict)

    //等待返回结果
    let payload = null;
    const op = recv('set_soft_breakpoint_ret', function (value) {
        payload = value.payload
    });
    op.wait()

    //写断点
    if(!checkbreakpoint(pc_addr)){
        Memory.patchCode(pc_addr, store_size, function (code) {
            //不同arch的断点写法不一样
            //todo 修复在libc中写代码段崩溃的问题
            ins_writer.putBytes(hex2buf(breakpoint_ins))
            ins_writer.flush()
        });
    }


    return true
}

/**
 * 通过不同的writer来恢复不同的断点
 * 重新设置页面保护
 * 自己的断点被访问后，恢复断点，设置内存保护
 * cmd 2
 * @param soft_breakpoint_info 断点信息
 * @param writer 不同的writer
 * @returns {boolean} 真表示异常处理 假表示异常没被处理
 */
function resume_softbreakpoint_set_pagebreak(soft_breakpoint_info,writer){
    const pc_addr = ptr(soft_breakpoint_info['break_addr']);
    const size = soft_breakpoint_info['break_len'];
    const content = hex2buf(soft_breakpoint_info['ins_content']); // arraybuffer
    const break_page_info = soft_breakpoint_info['break_page_info'];

    const ins_writer = new writer(pc_addr);


    //恢复原始字节码
    Memory.patchCode(pc_addr, size, function (code) {
        ins_writer.putBytes(content)
        ins_writer.flush()
      });


    //设置内存保护
    rpc.exports.setpageprotect(break_page_info[0],'---')
    const send_dict = {};
    send_dict['__tag'] = 'resume_soft_breakpoint'
    send_dict['addr'] = pc_addr
    send(send_dict)

    let info_ret = null;
    const op = recv('resume_soft_breakpoint_ret', function (value) {
        info_ret = value.payload
    });
    op.wait()
    return true
}

/**
 *
 * @param break_info 断点信息
 * @param writer writer
 * @param details 异常信息
 * @returns {boolean}
 */
function  resume_pagebreak_write_softbreakpoint_and_show(break_info,writer,details){
    //先调用cmd1的方法 然后把断点信息发送给py脚本
    const ret = resume_pagebreak_write_softbreakpoint(break_info, writer);
    const data_addr = ptr(break_info['break_addr']);
    const data = buf2hex(rpc.exports.readdata(data_addr, break_info['break_len']));
    const _pc = ptr(details['address']);
    const ins = Instruction.parse(_pc);
    const symbol = DebugSymbol.fromAddress(_pc);
    details['data'] = data
    details['symbol'] = symbol
    details['ins'] = ins.toString()
    details["operands"] = ins["operands"]
    details['__tag'] = "show_details"
    send(details)
    return ret
}

//返回为true false 表示这个异常是否被处理
function handle_cmd(info,details){

    const cmd = info['cmd'];
    switch (cmd){
        case 1:
            return resume_pagebreak_write_softbreakpoint(info,writer)
        case 2:
            return resume_softbreakpoint_set_pagebreak(info,writer)
        case 3:
            return resume_pagebreak_write_softbreakpoint_and_show(info,writer,details)
        case 100:
            return false
    }
}
rpc.exports = {
    getdevicearch(){
        //获取程序架构
        return Process.arch 
    },
    getplatform(){
        //获取平台架构
        return Process.platform
    },
    getpointersize(){
        //获取指针长度
        return Process.pointerSize
    },
    getpagesize(){
        //获取内存分页大小
        return Process.pageSize
    },
    getmodule(name){
        //获取模块基本信息
        return Process.findModuleByName(name)
    },
    setexceptionhandler(){
       //设置异常处理handler
       Process.setExceptionHandler(function(details){
           let break_info = null;
           details['__tag'] = "exception"
           send(details)
           const op = recv('exception_ret', function (value) {
               break_info = value.payload
           });
           op.wait()
            return  handle_cmd(break_info,details)
       }) 
    },
    getprotectranges(){
        //枚举内存保护标志
        return Process.enumerateRanges("---")
    },
    getexportbyname(so_name,symbol_name){
        return Module.getExportByName(so_name,symbol_name)
    },
    readdata(pointer,len){
        //读取数据
        return ptr(pointer).readByteArray(len)
    },
    setpageprotect(addr,flag){
        //设置页面内存保护
        Memory.protect(ptr(addr),0x1000,flag)
    }
}